import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const deactivatePage = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { fetchFeedWindow, syncDueFeeds, syncPageFeed, syncPageNow, syncUserFeedsNow, type FeedPage } from "@/lib/feed-sync";
import { MetaApiError, MetaRateLimitedError } from "@/lib/meta/client";
import { FEED_FIELDS_BASIC, FEED_FIELDS_FULL, SYNC_INTERVAL_MS } from "@/lib/meta/feed-posts";

const NOW = new Date("2026-10-21T12:00:00Z");
const MIN = 60_000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const graphPost = (n: number, over: Record<string, unknown> = {}) => ({
  id: `fb1_${n}`, message: `Bài ${n}`, created_time: hoursAgo(n), permalink_url: `https://www.facebook.com/fb1/posts/${n}`, status_type: "added_photos",
  reactions: { summary: { total_count: n } }, comments: { summary: { total_count: 1 } }, shares: { count: 0 }, ...over
});
const page: FeedPage = { id: "pr1", user_id: "u1", page_id: "fb1", page_access_token_encrypted: "enc" };
const feed = () => fake.tables.page_feed_posts;
const pageRow = () => fake.tables.facebook_pages.find((p) => p.id === "pr1")!;
const respond = (...posts: unknown[]) => metaGet.mockResolvedValue({ data: posts });

beforeEach(() => {
  fake.reset();
  metaGet.mockReset();
  deactivatePage.mockReset();
  fake.tables.facebook_pages.push({ ...page, is_active: true, removed_at: null, feed_next_sync_at: null, feed_synced_at: null, feed_sync_error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("syncPageFeed", () => {
  it("stores the Page's posts of the last 7 days and schedules the next read one interval (5 minutes by default) later", async () => {
    respond(graphPost(1), graphPost(2));
    const result = await syncPageFeed(page, NOW);
    expect(result).toMatchObject({ status: "synced", seen: 2, created: 2, missing: 0, complete: true, degraded: false });
    expect(metaGet).toHaveBeenCalledWith("fb1/posts", "token-of-enc", {
      fields: FEED_FIELDS_FULL, limit: "100", since: String(Math.floor((NOW.getTime() - 7 * 24 * 3600_000) / 1000))
    });
    expect(feed()).toHaveLength(2);
    expect(feed()[0]).toMatchObject({
      user_id: "u1", page_id: "pr1", facebook_post_id: "fb1_1", message: "Bài 1", reactions_count: 1, comments_count: 1, shares_count: 0,
      absent_checks: 0, missing_since: null, post_id: null, first_seen_at: NOW.toISOString()
    });
    expect(pageRow()).toMatchObject({ feed_synced_at: NOW.toISOString(), feed_sync_error: null });
    const wait = new Date(String(pageRow().feed_next_sync_at)).getTime() - NOW.getTime();
    expect(wait).toBeGreaterThanOrEqual(SYNC_INTERVAL_MS);
    expect(wait).toBeLessThan(SYNC_INTERVAL_MS + 2 * MIN);
  });

  it("refreshes the numbers of known posts without duplicating them or losing when they were first seen", async () => {
    respond(graphPost(1));
    await syncPageFeed(page, NOW);
    respond(graphPost(1, { reactions: { summary: { total_count: 99 } }, message: "Đã sửa" }));
    const later = new Date(NOW.getTime() + 15 * MIN);
    expect(await syncPageFeed(page, later)).toMatchObject({ status: "synced", created: 0, seen: 1 });
    expect(feed()).toHaveLength(1);
    expect(feed()[0]).toMatchObject({ reactions_count: 99, message: "Đã sửa", first_seen_at: NOW.toISOString(), last_seen_at: later.toISOString() });
  });

  it("recognises posts published by this app, by their own id or by an attached photo / video id", async () => {
    fake.tables.posts.push({ id: "app-post-1", user_id: "u1", facebook_post_id: "fb1_1" });
    fake.tables.posts.push({ id: "app-video-1", user_id: "u1", facebook_post_id: "video777" });
    fake.tables.posts.push({ id: "someone-elses", user_id: "u2", facebook_post_id: "fb1_3" });
    respond(
      graphPost(1),
      graphPost(2, { attachments: { data: [{ media_type: "video", target: { id: "video777" } }] } }),
      graphPost(3)
    );
    await syncPageFeed(page, NOW);
    const by = (id: string) => feed().find((f) => f.facebook_post_id === id)!;
    expect(by("fb1_1").post_id).toBe("app-post-1");
    expect(by("fb1_2").post_id).toBe("app-video-1");
    expect(by("fb1_3").post_id).toBeNull(); // another user's post is never linked
  });

  it("follows cursors across pages using only the cursor, never the URL that carries a token", async () => {
    metaGet
      .mockResolvedValueOnce({ data: [graphPost(1)], paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/...&access_token=SECRET" } })
      .mockResolvedValueOnce({ data: [graphPost(2)], paging: { cursors: { after: "CUR2" } } });
    expect(await syncPageFeed(page, NOW)).toMatchObject({ status: "synced", seen: 2, complete: true });
    expect(metaGet.mock.calls[1][2]).toMatchObject({ after: "CUR1" });
    expect(JSON.stringify(metaGet.mock.calls)).not.toContain("SECRET");
  });

  it("does not judge anything missing after an incomplete read", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, NOW);
    // The next read is cut off (a next page but no cursor to continue with) and only returns post 1.
    metaGet.mockResolvedValue({ data: [graphPost(1)], paging: { next: "https://x" } });
    const result = await syncPageFeed(page, new Date(NOW.getTime() + 15 * MIN));
    expect(result).toMatchObject({ status: "synced", complete: false, missing: 0 });
    expect(feed().every((f) => f.absent_checks === 0 && f.missing_since === null)).toBe(true);
  });

  it("believes a post is gone only after two complete reads without it, and forgets that if it comes back", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, NOW);
    const second = feed().find((f) => f.facebook_post_id === "fb1_2")!;

    respond(graphPost(1));
    await syncPageFeed(page, new Date(NOW.getTime() + 15 * MIN));
    expect(second).toMatchObject({ absent_checks: 1, missing_since: null });

    const t3 = new Date(NOW.getTime() + 30 * MIN);
    expect(await syncPageFeed(page, t3)).toMatchObject({ missing: 1 });
    expect(second).toMatchObject({ absent_checks: 2, missing_since: t3.toISOString() });

    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, new Date(NOW.getTime() + 45 * MIN));
    expect(second).toMatchObject({ absent_checks: 0, missing_since: null });
  });

  it("keeps the old posts that have left the 7-day window, without refreshing or flagging them", async () => {
    fake.tables.page_feed_posts.push({
      id: "old", user_id: "u1", page_id: "pr1", facebook_post_id: "fb1_old", created_time: hoursAgo(24 * 20), absent_checks: 0, missing_since: null, message: "cũ"
    });
    respond(graphPost(1));
    await syncPageFeed(page, NOW);
    expect(feed().find((f) => f.id === "old")).toMatchObject({ absent_checks: 0, missing_since: null, message: "cũ" });
  });

  it("keeps each user's copy of a post separate", async () => {
    fake.tables.page_feed_posts.push({ id: "theirs", user_id: "u2", page_id: "pr1", facebook_post_id: "fb1_1", created_time: hoursAgo(1), absent_checks: 0, message: "của u2" });
    respond(graphPost(1));
    await syncPageFeed(page, NOW);
    expect(feed().filter((f) => f.facebook_post_id === "fb1_1")).toHaveLength(2);
    expect(feed().find((f) => f.id === "theirs")?.message).toBe("của u2");
  });

  it("skips entries it cannot use and still stores the rest", async () => {
    respond(graphPost(1), { message: "no id" }, { id: "fb1_x", created_time: "garbage" });
    expect(await syncPageFeed(page, NOW)).toMatchObject({ status: "synced", seen: 1 });
  });

  describe("when Facebook refuses", () => {
    it("falls back to the plain post if the extra fields are refused", async () => {
      metaGet.mockRejectedValueOnce(new MetaApiError("(#100) bad field", "100", 400)).mockResolvedValue({ data: [{ id: "fb1_1", message: "m", created_time: hoursAgo(1) }] });
      const result = await syncPageFeed(page, NOW);
      expect(result).toMatchObject({ status: "synced", degraded: true, seen: 1 });
      expect(metaGet.mock.calls[1][2]).toMatchObject({ fields: FEED_FIELDS_BASIC });
      expect(feed()[0]).toMatchObject({ reactions_count: null, comments_count: null, shares_count: null });
    });

    it("asks for fewer posts at a time when told the request is too big", async () => {
      metaGet.mockRejectedValueOnce(new MetaApiError("Please reduce the amount of data", "1", 500)).mockResolvedValue({ data: [graphPost(1)] });
      expect(await syncPageFeed(page, NOW)).toMatchObject({ status: "synced" });
      expect(metaGet.mock.calls[1][2]).toMatchObject({ limit: "25" });
    });

    it("waits for a rate limit instead of recording an error", async () => {
      const until = NOW.getTime() + 10 * MIN;
      const limited = new MetaApiError("too many calls", "32", 400);
      limited.retryAt = until;
      metaGet.mockRejectedValue(limited);
      expect(await syncPageFeed(page, NOW)).toEqual({ status: "deferred", until: new Date(until) });
      expect(pageRow()).toMatchObject({ feed_next_sync_at: new Date(until).toISOString(), feed_sync_error: null });

      metaGet.mockRejectedValue(new MetaRateLimitedError(NOW.getTime() + 3 * MIN));
      expect(await syncPageFeed(page, NOW)).toMatchObject({ status: "deferred" });
    });

    it("switches the Page off when its token is dead, and tries again much later", async () => {
      metaGet.mockRejectedValue(new MetaApiError("token expired", "190", 401));
      expect(await syncPageFeed(page, NOW)).toEqual({ status: "failed", error: "PAGE_PERMISSION_LOST" });
      expect(deactivatePage).toHaveBeenCalledWith("u1", "pr1");
      expect(new Date(String(pageRow().feed_next_sync_at)).getTime() - NOW.getTime()).toBe(60 * MIN);
    });

    it("records a permission problem on the Page without switching it off, and backs off for an hour", async () => {
      metaGet.mockRejectedValue(new MetaApiError("(#10) permission", "10", 403));
      expect(await syncPageFeed(page, NOW)).toEqual({ status: "failed", error: "FB_PERMISSION_DENIED" });
      expect(deactivatePage).not.toHaveBeenCalled();
      expect(pageRow()).toMatchObject({ feed_sync_error: "FB_PERMISSION_DENIED" });
      expect(new Date(String(pageRow().feed_next_sync_at)).getTime() - NOW.getTime()).toBe(60 * MIN);
    });

    it("retries a network failure soon, and a later success clears the error", async () => {
      metaGet.mockRejectedValue(new Error("network down"));
      expect(await syncPageFeed(page, NOW)).toEqual({ status: "failed", error: "FB_UNAVAILABLE" });
      expect(new Date(String(pageRow().feed_next_sync_at)).getTime() - NOW.getTime()).toBe(5 * MIN);
      respond(graphPost(1));
      await syncPageFeed(page, new Date(NOW.getTime() + 5 * MIN));
      expect(pageRow().feed_sync_error).toBeNull();
    });

    it("does not touch the stored posts when the read fails", async () => {
      respond(graphPost(1), graphPost(2));
      await syncPageFeed(page, NOW);
      metaGet.mockRejectedValue(new MetaApiError("server error", "2", 500));
      await syncPageFeed(page, new Date(NOW.getTime() + 15 * MIN));
      expect(feed()).toHaveLength(2);
      expect(feed().every((f) => f.absent_checks === 0)).toBe(true);
    });
  });
});

describe("fetchFeedWindow", () => {
  it("stops after 10 batches and says the read is incomplete", async () => {
    metaGet.mockImplementation(async () => ({ data: [], paging: { cursors: { after: "next" }, next: "https://x" } }));
    const result = await fetchFeedWindow("tok", "fb1", new Date(NOW.getTime() - 7 * 24 * 3600_000));
    expect(result.complete).toBe(false);
    expect(metaGet).toHaveBeenCalledTimes(10);
  });
});

describe("syncDueFeeds", () => {
  const addPage = (id: string, over: Record<string, unknown> = {}) => fake.tables.facebook_pages.push({
    id, user_id: "u1", page_id: `fb-${id}`, page_access_token_encrypted: "enc", is_active: true, removed_at: null, feed_next_sync_at: null, ...over
  });

  beforeEach(() => { fake.tables.facebook_pages.length = 0; });

  it("reads the Pages that are due (new, or past their time) and no others", async () => {
    addPage("new");
    addPage("overdue", { feed_next_sync_at: new Date(NOW.getTime() - MIN).toISOString() });
    addPage("later", { feed_next_sync_at: new Date(NOW.getTime() + 10 * MIN).toISOString() });
    addPage("off", { is_active: false });
    addPage("removed", { removed_at: NOW.toISOString() });
    metaGet.mockResolvedValue({ data: [] });
    const stats = await syncDueFeeds({ now: NOW });
    expect(stats).toMatchObject({ due: 2, synced: 2, failed: 0, deferred: 0 });
    expect(metaGet.mock.calls.map((c) => c[0]).sort()).toEqual(["fb-new/posts", "fb-overdue/posts"]);
    expect(fake.tables.facebook_pages.find((p) => p.id === "later")?.feed_synced_at ?? null).toBeNull();
  });

  it("pushes the Page's next turn forward, so an immediate second run reads nothing", async () => {
    addPage("a");
    metaGet.mockResolvedValue({ data: [] });
    await syncDueFeeds({ now: NOW });
    metaGet.mockClear();
    expect(await syncDueFeeds({ now: new Date(NOW.getTime() + MIN) })).toMatchObject({ due: 0 });
    expect(metaGet).not.toHaveBeenCalled();
    expect(await syncDueFeeds({ now: new Date(NOW.getTime() + 18 * MIN) })).toMatchObject({ due: 1, synced: 1 });
  });

  it("never reads the same Page twice when two runs overlap", async () => {
    for (let i = 0; i < 6; i++) addPage(`p${i}`);
    metaGet.mockImplementation(async () => { await new Promise((r) => setImmediate(r)); return { data: [] }; });
    const [a, b] = await Promise.all([syncDueFeeds({ now: NOW }), syncDueFeeds({ now: NOW })]);
    expect(metaGet).toHaveBeenCalledTimes(6);
    expect(a.synced + b.synced).toBe(6);
    expect(a.skipped + b.skipped).toBeGreaterThan(0);
  });

  it("counts failures and rate limits separately and carries on with the other Pages", async () => {
    addPage("ok"); addPage("bad"); addPage("slow");
    metaGet.mockImplementation(async (path: string) => {
      if (path.startsWith("fb-bad")) throw new MetaApiError("(#10) permission", "10", 403);
      if (path.startsWith("fb-slow")) { const e = new MetaApiError("too many calls", "32", 400); e.retryAt = NOW.getTime() + 5 * MIN; throw e; }
      return { data: [] };
    });
    expect(await syncDueFeeds({ now: NOW })).toMatchObject({ synced: 1, failed: 1, deferred: 1 });
  });

  it("stops starting Pages when its time budget is used and leaves the rest due", async () => {
    for (let i = 0; i < 5; i++) addPage(`p${i}`);
    metaGet.mockResolvedValue({ data: [] });
    const stats = await syncDueFeeds({ now: NOW, budgetMs: -1, concurrency: 1 });
    expect(stats).toMatchObject({ due: 5, synced: 0, stoppedEarly: true });
    expect(fake.tables.facebook_pages.every((p) => p.feed_next_sync_at === null)).toBe(true);
  });
});

describe("syncPageNow", () => {
  it("syncs a Page of the user, at most once a minute", async () => {
    respond(graphPost(1));
    expect(await syncPageNow("u1", "pr1", NOW)).toMatchObject({ status: "synced", seen: 1 });
    expect(await syncPageNow("u1", "pr1", new Date(NOW.getTime() + 30_000))).toEqual({ status: "too_soon" });
    expect(await syncPageNow("u1", "pr1", new Date(NOW.getTime() + 2 * MIN))).toMatchObject({ status: "synced" });
  });

  it("confirms a deleted post in the same click: the second read follows the first one at once", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageNow("u1", "pr1", NOW, { confirmDelayMs: 0 });
    const second = feed().find((f) => f.facebook_post_id === "fb1_2")!;

    respond(graphPost(1));
    const later = new Date(NOW.getTime() + 20 * MIN);
    expect(await syncPageNow("u1", "pr1", later, { confirmDelayMs: 0 })).toMatchObject({ status: "synced", missing: 1 });
    expect(second).toMatchObject({ absent_checks: 2 });
    expect(second.missing_since).not.toBeNull();
    expect(metaGet).toHaveBeenCalledTimes(3);
  });

  it("does not read twice when no post was missed", async () => {
    respond(graphPost(1));
    await syncPageNow("u1", "pr1", NOW, { confirmDelayMs: 0 });
    expect(metaGet).toHaveBeenCalledTimes(1);
  });

  it("refuses another user's Page, a removed Page and an inactive Page", async () => {
    expect(await syncPageNow("u2", "pr1", NOW)).toEqual({ status: "not_found" });
    pageRow().is_active = false;
    expect(await syncPageNow("u1", "pr1", NOW)).toEqual({ status: "inactive" });
    pageRow().removed_at = NOW.toISOString();
    expect(await syncPageNow("u1", "pr1", NOW)).toEqual({ status: "not_found" });
    expect(metaGet).not.toHaveBeenCalled();
  });
});

describe("syncUserFeedsNow", () => {
  const addPage = (id: string, over: Record<string, unknown> = {}) => fake.tables.facebook_pages.push({
    id, user_id: "u1", page_id: `fb-${id}`, page_access_token_encrypted: "enc", is_active: true, removed_at: null,
    feed_next_sync_at: null, feed_synced_at: null, feed_sync_error: null, ...over
  });

  it("reads every active Page of the user and no one else's", async () => {
    addPage("pr2"); addPage("pr3", { is_active: false }); addPage("pr4", { removed_at: NOW.toISOString() }); addPage("pr5", { user_id: "u2" });
    respond(graphPost(1));
    expect(await syncUserFeedsNow("u1", NOW)).toMatchObject({ pages: 2, synced: 2, recent: 0, failed: 0, deferred: 0 });
    expect(metaGet).toHaveBeenCalledTimes(2);
  });

  it("counts a Page read a moment ago as recent, and carries on when one Page fails", async () => {
    addPage("pr2", { feed_synced_at: new Date(NOW.getTime() - 10_000).toISOString() }); addPage("pr6");
    metaGet.mockImplementation(async (path: string) => {
      if (path.startsWith("fb-pr6")) throw new MetaApiError("(#10) permission", "10", 403);
      return { data: [] };
    });
    expect(await syncUserFeedsNow("u1", NOW)).toMatchObject({ pages: 3, synced: 1, recent: 1, failed: 1, lastError: expect.any(String) });
  });
});

describe("posts the app published itself", () => {
  const ownPost = () => fake.tables.posts[0];
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
  beforeEach(() => {
    fake.tables.posts = [{ id: "p1", user_id: "u1", page_id: "pr1", facebook_post_id: "fb1_2", facebook_deleted_at: null }];
  });

  it("marks the app's post deleted on Facebook after two reads without it, tells the user once, and restores it when it is back", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, NOW);
    expect(feed().find((f) => f.facebook_post_id === "fb1_2")).toMatchObject({ post_id: "p1" });

    respond(graphPost(1));
    await syncPageFeed(page, at(5));
    expect(ownPost().facebook_deleted_at).toBeNull(); // one miss is not believed yet

    await syncPageFeed(page, at(10));
    expect(ownPost().facebook_deleted_at).not.toBeNull();
    expect(fake.tables.notifications).toHaveLength(1);
    expect(fake.tables.notifications[0]).toMatchObject({ type: "POST_DELETED_ON_FACEBOOK", post_id: "p1", page_id: "pr1" });
    expect(fake.tables.post_events.map((e) => e.type)).toEqual(["detected_missing"]);

    await syncPageFeed(page, at(15)); // already marked: nothing more happens
    expect(fake.tables.notifications).toHaveLength(1);
    expect(fake.tables.post_events).toHaveLength(1);

    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, at(20));
    expect(ownPost().facebook_deleted_at).toBeNull();
    expect(fake.tables.post_events.map((e) => e.type)).toEqual(["detected_missing", "detected_live"]);
  });

  it("catches up on a deletion that was recorded in the mirror before the post was marked", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, NOW);
    feed().find((f) => f.facebook_post_id === "fb1_2")!.missing_since = at(1).toISOString();
    respond(graphPost(1));
    await syncPageFeed(page, at(5));
    expect(ownPost().facebook_deleted_at).not.toBeNull();
  });

  it("does not restore a post the app deleted itself because Facebook still listed it for a moment", async () => {
    respond(graphPost(1), graphPost(2));
    await syncPageFeed(page, NOW);
    ownPost().facebook_deleted_at = at(1).toISOString(); // deleted from the app
    respond(graphPost(1)); // first read without it: waiting for the second
    await syncPageFeed(page, at(5));
    expect(ownPost().facebook_deleted_at).not.toBeNull();
  });
});
