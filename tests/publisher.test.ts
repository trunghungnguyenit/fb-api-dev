import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- A tiny in-memory stand-in for the parts of supabase-js the publisher uses --------------------------------
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let nextId = 1;

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private inserted: Row | null = null;
  private wantsRows = false;
  constructor(private table: string) {}
  select() { this.wantsRows = true; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  insert(row: Row) { this.inserted = { id: `row${nextId++}`, ...row }; tables[this.table].push(this.inserted); return this; }
  eq(col: string, value: unknown) { this.filters.push((r) => r[col] === value); return this; }
  lte(col: string, value: string) { this.filters.push((r) => String(r[col]) <= value); return this; }
  lt(col: string, value: string) { this.filters.push((r) => r[col] != null && String(r[col]) < value); return this; }
  is(col: string, value: unknown) { this.filters.push((r) => (r[col] ?? null) === value); return this; }
  not(col: string, _op: string, value: unknown) { this.filters.push((r) => (r[col] ?? null) !== value); return this; }
  in(col: string, values: unknown[]) { this.filters.push((r) => values.includes(r[col])); return this; }
  // Not evaluated: the due-queue filters (or / paging) belong to the database, and are checked against it separately.
  or() { return this; }
  order() { return this; }
  limit() { return this; }
  private run() {
    if (this.inserted) return { data: this.wantsRows ? this.inserted : null, error: null };
    const matched = tables[this.table].filter((r) => this.filters.every((f) => f(r)));
    if (this.patch) for (const r of matched) Object.assign(r, this.patch);
    return { data: this.wantsRows ? matched : null, error: null };
  }
  maybeSingle() { const { data } = this.run(); return Promise.resolve({ data: (data as Row[])[0] ?? null, error: null }); }
  single() { const { data, error } = this.run(); return Promise.resolve({ data: Array.isArray(data) ? data[0] : data, error }); }
  then(resolve: (v: unknown) => void) { resolve(this.run()); }
}

const metaPost = vi.fn();
const deactivatePage = vi.fn();
const notify = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (table: string) => new Query(table) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/notifications", () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaPost: (...a: unknown[]) => metaPost(...a)
}));

import { processDuePosts, publishPost, runPublishCycle } from "@/lib/publisher";
import { MetaApiError, MetaRateLimitedError } from "@/lib/meta/client";

const due = (over: Row = {}) => ({
  id: "post1", user_id: "u1", page_id: "pageRow1", message: "Xin chào", link_url: null as string | null,
  attempt_count: 0, scheduled_at: "2026-10-21T00:00:00Z", ...over
});
const row = (id: string) => tables.posts.find((p) => p.id === id)!;

function seed(post: Row = due()) {
  tables.posts = [{ ...post, status: "scheduled", sent_at: null, next_attempt_at: null, last_error_code: null }];
  tables.facebook_pages = [{ id: "pageRow1", user_id: "u1", page_id: "fb-page-1", page_access_token_encrypted: "enc", is_active: true }];
  tables.publish_attempts = [];
}

describe("publishPost", () => {
  beforeEach(() => {
    for (const m of [metaPost, deactivatePage, notify]) m.mockReset();
    seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("publishes a post: claims it, sends it with the Page's own token, records the Facebook id", async () => {
    metaPost.mockResolvedValue({ id: "fb-post-9" });
    expect(await publishPost(due({ link_url: "https://example.com" }))).toEqual({ result: "published" });
    expect(metaPost).toHaveBeenCalledWith("fb-page-1/feed", "token-of-enc", { message: "Xin chào", link: "https://example.com" }, expect.any(Number));
    expect(row("post1")).toMatchObject({ status: "published", facebook_post_id: "fb-post-9", attempt_count: 1, last_error_code: null });
    expect(row("post1").sent_at).toBeTruthy();
    expect(tables.publish_attempts[0]).toMatchObject({ outcome: "success", facebook_post_id: "fb-post-9", attempt_number: 1 });
  });

  it("does nothing when another worker already claimed the post", async () => {
    tables.posts[0].status = "publishing";
    expect(await publishPost(due())).toEqual({ result: "lost" });
    expect(metaPost).not.toHaveBeenCalled();
    expect(tables.publish_attempts).toHaveLength(0);
  });

  it("keeps a post of a switched-off Page queued and tells the scheduler to leave that Page alone", async () => {
    tables.facebook_pages[0].is_active = false;
    expect(await publishPost(due())).toEqual({ result: "requeued", blockPageUntil: Infinity });
    expect(metaPost).not.toHaveBeenCalled();
    expect(row("post1")).toMatchObject({ status: "scheduled", last_error_code: "PAGE_INACTIVE", sent_at: null });
  });

  it("defers instead of failing when Meta rate limits the Page, until the time Meta gave", async () => {
    const retryAt = Date.now() + 120_000;
    const error = new MetaApiError("too many calls", "32", 400);
    error.retryAt = retryAt;
    metaPost.mockRejectedValue(error);
    expect(await publishPost(due())).toEqual({ result: "requeued", blockPageUntil: retryAt });
    expect(row("post1")).toMatchObject({ status: "scheduled", sent_at: null, next_attempt_at: new Date(retryAt).toISOString(), last_error_code: null });
    expect(tables.publish_attempts[0]).toMatchObject({ outcome: "failure", error_code: "32" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("defers the same way when our own back-off stopped the call before anything was sent", async () => {
    const retryAt = Date.now() + 30_000;
    metaPost.mockRejectedValue(new MetaRateLimitedError(retryAt));
    expect(await publishPost(due())).toEqual({ result: "requeued", blockPageUntil: retryAt });
    expect(row("post1")).toMatchObject({ status: "scheduled", next_attempt_at: new Date(retryAt).toISOString() });
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the outcome unknown (never a retry) when the request may have reached Facebook", async () => {
    metaPost.mockRejectedValue(new Error("network reset"));
    expect(await publishPost(due())).toEqual({ result: "failed" });
    expect(row("post1")).toMatchObject({ status: "failed", last_error_code: "AMBIGUOUS" });
    expect(tables.publish_attempts[0]).toMatchObject({ outcome: "ambiguous" });
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_AMBIGUOUS", postId: "post1" }));
  });

  it("fails a post Facebook cleanly rejected, and notifies the user", async () => {
    metaPost.mockRejectedValue(new MetaApiError("bad link", "100", 400));
    expect(await publishPost(due())).toEqual({ result: "failed" });
    expect(row("post1")).toMatchObject({ status: "failed", last_error_code: "FB_CONTENT_REJECTED" });
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_FAILED", code: "FB_CONTENT_REJECTED", dedupeKey: "publish-failed:post1:1" }));
  });

  it("switches the Page off on a dead token, keeps the post queued and leaves the Page alone", async () => {
    metaPost.mockRejectedValue(new MetaApiError("token expired", "190", 401));
    expect(await publishPost(due())).toEqual({ result: "requeued", blockPageUntil: Infinity });
    expect(deactivatePage).toHaveBeenCalledWith("u1", "pageRow1");
    expect(row("post1")).toMatchObject({ status: "scheduled", last_error_code: "PAGE_INACTIVE" });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("processDuePosts (one post)", () => {
  beforeEach(() => {
    for (const m of [metaPost, deactivatePage, notify]) m.mockReset();
    seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("publishes just that post and reports it", async () => {
    metaPost.mockResolvedValue({ id: "fb-1" });
    expect(await processDuePosts({ postId: "post1" })).toEqual([{ id: "post1", result: "published" }]);
    expect(row("post1").status).toBe("published");
  });

  it("returns nothing for a post that is not due or does not exist", async () => {
    expect(await processDuePosts({ postId: "missing" })).toEqual([]);
    expect(metaPost).not.toHaveBeenCalled();
  });
});

describe("runPublishCycle", () => {
  beforeEach(() => {
    for (const m of [metaPost, deactivatePage, notify]) m.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("publishes every due post of many users and Pages, once each, and reports the run", async () => {
    tables.posts = [];
    tables.facebook_pages = [];
    tables.publish_attempts = [];
    for (let u = 0; u < 3; u++) for (let g = 0; g < 4; g++) {
      tables.facebook_pages.push({ id: `page-${u}-${g}`, user_id: `u${u}`, page_id: `fb-${u}-${g}`, page_access_token_encrypted: "enc", is_active: true });
    }
    for (let i = 0; i < 60; i++) {
      const u = i % 3; const g = i % 4;
      tables.posts.push({ id: `p${i}`, user_id: `u${u}`, page_id: `page-${u}-${g}`, message: `m${i}`, link_url: null, status: "scheduled",
        scheduled_at: "2026-10-21T00:00:00Z", attempt_count: 0, sent_at: null, next_attempt_at: null, last_error_code: null });
    }
    let n = 0;
    metaPost.mockImplementation(async () => ({ id: `fb-post-${n++}` }));

    const { results, stats } = await runPublishCycle();

    expect(stats).toMatchObject({ started: 60, published: 60, failed: 0, requeued: 0, lost: 0, stopReason: "drained", hasMore: false });
    expect(results).toHaveLength(60);
    expect(tables.posts.every((p) => p.status === "published")).toBe(true);
    expect(new Set(tables.posts.map((p) => p.facebook_post_id)).size).toBe(60);
    expect(metaPost).toHaveBeenCalledTimes(60);
  });

  it("leaves a rate-limited Page's remaining posts untouched instead of bouncing each one", async () => {
    tables.posts = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`, user_id: "u1", page_id: "pageRow1", message: "m", link_url: null, status: "scheduled",
      scheduled_at: "2026-10-21T00:00:00Z", attempt_count: 0, sent_at: null, next_attempt_at: null, last_error_code: null
    }));
    tables.facebook_pages = [{ id: "pageRow1", user_id: "u1", page_id: "fb-page-1", page_access_token_encrypted: "enc", is_active: true }];
    tables.publish_attempts = [];
    const error = new MetaApiError("too many calls", "32", 400);
    error.retryAt = Date.now() + 600_000;
    metaPost.mockRejectedValue(error);

    const { stats } = await runPublishCycle();

    expect(metaPost).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ started: 1, requeued: 1, skippedBlocked: 7 });
    expect(tables.posts.filter((p) => p.status === "scheduled")).toHaveLength(8);
    expect(tables.publish_attempts).toHaveLength(1);
  });
});
