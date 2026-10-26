import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));

import { loadTopPosts, parseTopSort, rankPosts, TOP_LIMIT, type FeedRowForTop } from "@/lib/top-posts";

const NOW = new Date("2026-10-26T05:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const row = (id: string, r: number | null, c: number | null, s: number | null, over: Partial<FeedRowForTop> = {}): FeedRowForTop => ({
  id, message: `Bài ${id}`, created_time: hoursAgo(5), permalink_url: null, status_type: "added_photos", post_id: null,
  reactions_count: r, comments_count: c, shares_count: s, ...over
});

describe("rankPosts", () => {
  const list = [row("a", 10, 2, 1), row("b", 3, 20, 0), row("c", 5, 5, 5), row("d", null, null, null), row("e", 0, 0, 0)];

  it("ranks by the total of reactions, comments and shares by default", () => {
    expect(rankPosts(list, "total").map((p) => [p.id, p.total])).toEqual([["b", 23], ["c", 15], ["a", 13]]);
  });

  it("can rank by one column, and leaves out posts with nothing in it", () => {
    expect(rankPosts(list, "reactions", 10).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(rankPosts(list, "comments", 10).map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(rankPosts(list, "shares", 10).map((p) => p.id)).toEqual(["c", "a"]);
  });

  it("treats a count Facebook did not give as nothing, and never lists posts without any engagement", () => {
    expect(rankPosts(list, "total").map((p) => p.id)).not.toContain("d");
    expect(rankPosts(list, "total").map((p) => p.id)).not.toContain("e");
  });

  it("breaks ties with the newest post first, then by id, so the order is stable", () => {
    const tied = [row("old", 5, 0, 0, { created_time: hoursAgo(50) }), row("new", 5, 0, 0, { created_time: hoursAgo(2) }), row("also-new", 5, 0, 0, { created_time: hoursAgo(2) })];
    expect(rankPosts(tied, "total").map((p) => p.id)).toEqual(["also-new", "new", "old"]);
  });

  it("keeps the first 10 only, and links the app's own post", () => {
    const many = Array.from({ length: 25 }, (_, i) => row(`p${String(i).padStart(2, "0")}`, i + 1, 0, 0, i === 24 ? { post_id: "app-1" } : {}));
    const top = rankPosts(many, "total");
    expect(top).toHaveLength(TOP_LIMIT);
    expect(top[0]).toMatchObject({ id: "p24", appPostId: "app-1", total: 25 });
    expect(rankPosts(many, "total", 3)).toHaveLength(3);
  });
});

describe("parseTopSort", () => {
  it("accepts the four sorts and falls back to the total for anything else", () => {
    for (const sort of ["total", "reactions", "comments", "shares"]) expect(parseTopSort(sort)).toBe(sort);
    for (const bad of ["", "likes", undefined, null, 5, "TOTAL"]) expect(parseTopSort(bad)).toBe("total");
  });
});

describe("loadTopPosts", () => {
  const stored = (id: string, over: Record<string, unknown> = {}) => ({
    id, user_id: "u1", page_id: "pr1", message: `Bài ${id}`, created_time: hoursAgo(10), permalink_url: null, status_type: "added_photos", post_id: null,
    reactions_count: 1, comments_count: 1, shares_count: 0, missing_since: null, ...over
  });

  beforeEach(() => {
    fake.reset();
    fake.tables.facebook_pages.push({ id: "pr1", user_id: "u1", feed_synced_at: hoursAgo(0.1) });
  });

  it("reads the stored copy of this Fanpage, this user and the last 7 days, without deleted posts", async () => {
    fake.tables.page_feed_posts.push(
      stored("fresh", { reactions_count: 9 }),
      stored("old", { created_time: hoursAgo(24 * 8), reactions_count: 99 }),            // outside the 7 days
      stored("gone", { missing_since: hoursAgo(1), reactions_count: 99 }),                // deleted on Facebook
      stored("other-page", { page_id: "pr2", reactions_count: 99 }),
      stored("other-user", { user_id: "u2", reactions_count: 99 })
    );
    const result = await loadTopPosts("u1", "pr1", "total", NOW);
    expect(result.posts.map((p) => p.id)).toEqual(["fresh"]);
    expect(result).toMatchObject({ sort: "total", windowDays: 7, syncedAt: hoursAgo(0.1) });
  });

  it("leaves out an app post the app already knows is deleted, even before the sync marks its copy missing", async () => {
    fake.tables.posts.push(
      { id: "app-gone", user_id: "u1", facebook_deleted_at: hoursAgo(1) },
      { id: "app-live", user_id: "u1", facebook_deleted_at: null }
    );
    fake.tables.page_feed_posts.push(
      stored("gone", { post_id: "app-gone", reactions_count: 50 }),
      stored("live", { post_id: "app-live", reactions_count: 5 }),
      stored("direct", { reactions_count: 7 })
    );
    expect((await loadTopPosts("u1", "pr1", "total", NOW)).posts.map((p) => p.id)).toEqual(["direct", "live"]);
  });

  it("is empty, with no error, for a Fanpage that has no posts yet", async () => {
    expect((await loadTopPosts("u1", "pr1", "comments", NOW)).posts).toEqual([]);
  });

  it("never asks Facebook", async () => {
    // The module does not even import the Graph client: nothing to mock, nothing to call.
    const source = (await import("node:fs")).readFileSync("src/lib/top-posts.ts", "utf8");
    expect(source).not.toMatch(/meta\/client|metaGet|fetch\(/);
  });
});
