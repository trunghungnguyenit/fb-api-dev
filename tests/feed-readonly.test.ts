import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/csrf", () => ({ isSameOrigin: () => true }));
vi.mock("@/lib/publisher", () => ({ AMBIGUOUS_CODE: "AMBIGUOUS", processDuePosts: vi.fn(async () => []) }));
vi.mock("@/lib/facebook-posts", () => ({
  deleteFacebookPost: vi.fn(), editFacebookMessage: vi.fn(), isGoneOnFacebook: vi.fn(), markFacebookGone: vi.fn(), recordEvent: vi.fn(),
  clearFacebookGone: vi.fn(), readFacebookPost: vi.fn(), FacebookActionError: class extends Error {}
}));

import { PATCH, DELETE } from "@/app/api/posts/[id]/route";
import { POST as repost } from "@/app/api/posts/[id]/repost/route";
import { POST as bulk } from "@/app/api/posts/bulk/route";
import { GET as facebookStats } from "@/app/api/posts/[id]/facebook/route";

const FEED_ID = "33333333-3333-4333-8333-333333333333";
const PAGE = "11111111-1111-4111-8111-111111111111";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new NextRequest("http://localhost/api/x", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  fake.reset();
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_name: "Cửa hàng", is_active: true });
  fake.tables.page_feed_posts.push({
    id: FEED_ID, user_id: "u1", page_id: PAGE, facebook_post_id: "fb_1", message: "Đăng trên Facebook", created_time: "2026-10-21T00:00:00Z",
    absent_checks: 0, missing_since: null, post_id: null, permalink_url: "https://www.facebook.com/x/posts/1"
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("posts read from Facebook are read-only", () => {
  const untouched = () => expect(fake.tables.page_feed_posts).toEqual([expect.objectContaining({ id: FEED_ID, message: "Đăng trên Facebook", missing_since: null })]);

  it("cannot be edited, scheduled, cancelled or deleted through the post API", async () => {
    for (const action of ["edit", "schedule", "cancel", "draft", "mark_deleted"]) {
      const res = await PATCH(req("PATCH", { action, message: "hacked", scheduledAt: new Date(Date.now() + 3.6e6).toISOString(), publishNow: true }), params(FEED_ID));
      expect(res.status).toBe(404);
    }
    expect((await DELETE(req("DELETE"), params(FEED_ID))).status).toBe(404);
    untouched();
  });

  it("cannot be re-posted, singly or in bulk, nor looked up like an app post", async () => {
    const res = await repost(req("POST", { mode: "clone", message: "x", pageIds: [PAGE], when: "draft" }), params(FEED_ID));
    expect(res.status).toBe(404);
    expect(fake.tables.posts).toHaveLength(0);
    expect((await facebookStats(req("GET"), params(FEED_ID))).status).toBe(404);

    for (const action of ["repost", "cancel", "delete"]) {
      const body = await (await bulk(req("POST", { action, ids: [FEED_ID], when: "draft" }))).json();
      expect(body.done).toBe(0);
      expect(body.skipped).toEqual([expect.objectContaining({ id: FEED_ID, code: "POST_NOT_FOUND" })]);
    }
    expect(fake.tables.posts).toHaveLength(0);
    untouched();
  });
});

describe("only the sync job writes to the mirror of Facebook posts", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("no other module inserts, updates, upserts or deletes page_feed_posts rows", () => {
    const root = join(process.cwd(), "src");
    const writers = sourceFiles(root)
      .filter((file) => /\.feed\s*\.\s*(insert|update|upsert|delete)\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(process.cwd(), file).split(sep).join("/"));
    // The sync writes what Facebook said. new-comments.ts only keeps the user's own bookkeeping (see the next test).
    expect(writers).toEqual(["src/lib/feed-sync.ts", "src/lib/new-comments.ts"]);
  });

  it("the new-comments bookkeeping only ever updates the two comment counters of a row, never the post itself", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/new-comments.ts"), "utf8");
    expect(source).not.toMatch(/\.feed\s*\.\s*(insert|upsert|delete)\b/);
    // Every update patch is one of the literals below: no other column can be written without failing this test.
    const patches = [...source.matchAll(/\.feed\s*\.\s*update\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(patches.sort()).toEqual(
      ["patch", "{ comments_seen_count: row.comments_count }", "{ comments_count: total, comments_seen_count: total }"].sort()
    );
    expect(source).toContain("const patch: Record<string, number> = { comments_count: row.comments_count + 1 };");
    expect(source).toContain("patch.comments_seen_count = row.comments_seen_count + 1;");
  });

  it("nothing writes to it through the raw table name either", () => {
    const root = join(process.cwd(), "src");
    const rawWriters = sourceFiles(root)
      .filter((file) => /from\(\s*["']page_feed_posts["']\s*\)\s*\.\s*(insert|update|upsert|delete)/.test(readFileSync(file, "utf8")))
      .map((file) => relative(process.cwd(), file).split(sep).join("/"));
    expect(rawWriters).toEqual([]);
  });
});
