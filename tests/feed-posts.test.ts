import { describe, expect, it } from "vitest";
import { facebookUrl, feedSyncIntervalMs, mapFeedPost, nextSyncAfter, planAbsences, SYNC_INTERVAL_MS, SYNC_WINDOW_MS, windowStart } from "@/lib/meta/feed-posts";

describe("mapFeedPost", () => {
  it("maps a plain text post", () => {
    expect(mapFeedPost({
      id: "1_2", message: "Xin chào", created_time: "2026-10-21T08:00:00+0000", permalink_url: "https://www.facebook.com/1/posts/2", status_type: "mobile_status_update",
      reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 1 }
    })).toEqual({
      facebook_post_id: "1_2", message: "Xin chào", permalink_url: "https://www.facebook.com/1/posts/2", status_type: "mobile_status_update",
      created_time: "2026-10-21T08:00:00.000Z", media: [], reactions_count: 12, comments_count: 3, shares_count: 1, link_keys: ["1_2"]
    });
  });

  it("copes with a photo-only post (no message) and missing engagement data", () => {
    const post = mapFeedPost({ id: "1_3", created_time: "2026-10-21T08:00:00+0000" });
    expect(post).toMatchObject({ message: "", reactions_count: null, comments_count: null, shares_count: null, media: [] });
  });

  it("flattens attachments, keeps their target ids as ways to recognise the post, and caps the list", () => {
    const post = mapFeedPost({
      id: "1_4", created_time: "2026-10-21T08:00:00+0000",
      attachments: { data: [{ media_type: "album", target: { id: "album9" }, subattachments: { data: [
        { media_type: "photo", url: "https://www.facebook.com/photo/?fbid=11", target: { id: "11" } },
        { media_type: "photo", url: "https://www.facebook.com/photo/?fbid=12", target: { id: "12" } }
      ] } }] }
    });
    expect(post?.media).toEqual([
      { type: "photo", url: "https://www.facebook.com/photo/?fbid=11", target_id: "11" },
      { type: "photo", url: "https://www.facebook.com/photo/?fbid=12", target_id: "12" }
    ]);
    expect(post?.link_keys.sort()).toEqual(["1_4", "11", "12", "album9"].sort());

    const many = mapFeedPost({ id: "1_5", created_time: "2026-10-21T08:00:00+0000", attachments: { data: Array.from({ length: 30 }, (_, i) => ({ type: "photo", target: { id: String(i) } })) } });
    expect(many?.media).toHaveLength(10);
  });

  it("never keeps a link that is not safe to put in an href", () => {
    const post = mapFeedPost({
      id: "1_6", created_time: "2026-10-21T08:00:00+0000", permalink_url: "javascript:alert(1)",
      attachments: { data: [{ type: "share", url: "javascript:alert(2)" }, { type: "share", url: "https://example.com/x" }] }
    });
    expect(post?.permalink_url).toBeNull();
    expect(post?.media.map((m) => m.url)).toEqual([null, "https://example.com/x"]);
  });

  it("drops entries it cannot use", () => {
    expect(mapFeedPost({ message: "no id", created_time: "2026-10-21T08:00:00+0000" })).toBeNull();
    expect(mapFeedPost({ id: "1_7" })).toBeNull();
    expect(mapFeedPost({ id: "1_7", created_time: "not a date" })).toBeNull();
    expect(mapFeedPost(null as never)).toBeNull();
  });

  it("a missing share count means zero when engagement was asked for, and unknown when it was not", () => {
    const g = { id: "1_9", created_time: "2026-10-21T08:00:00+0000", reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } } };
    expect(mapFeedPost(g, { engagement: true })?.shares_count).toBe(0);
    expect(mapFeedPost(g)?.shares_count).toBeNull();
    expect(mapFeedPost({ ...g, shares: { count: 4 } }, { engagement: true })?.shares_count).toBe(4);
  });

  it("ignores nonsense counts", () => {
    const post = mapFeedPost({ id: "1_8", created_time: "2026-10-21T08:00:00+0000", reactions: { summary: { total_count: -4 } }, shares: { count: "x" as never } });
    expect(post).toMatchObject({ reactions_count: null, shares_count: null });
  });
});

describe("facebookUrl", () => {
  it("accepts Facebook https links, completes relative paths, rejects the rest", () => {
    expect(facebookUrl("https://www.facebook.com/a/posts/1")).toBe("https://www.facebook.com/a/posts/1");
    expect(facebookUrl("https://m.facebook.com/story.php?id=1")).toBe("https://m.facebook.com/story.php?id=1");
    expect(facebookUrl("/page/videos/12/")).toBe("https://www.facebook.com/page/videos/12/");
    for (const bad of ["http://www.facebook.com/x", "https://facebook.com.evil.example/x", "https://evil.example/facebook.com", "javascript:alert(1)", "data:text/html,x", "", undefined, null]) {
      expect(facebookUrl(bad as string)).toBeNull();
    }
  });
});

describe("sync timing", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("reads the interval from FEED_SYNC_INTERVAL_MIN: 5 minutes by default, 1 to 60 whole minutes otherwise", () => {
    expect(feedSyncIntervalMs(undefined)).toBe(5 * 60_000);
    expect(feedSyncIntervalMs("1")).toBe(60_000);
    expect(feedSyncIntervalMs("15")).toBe(15 * 60_000);
    for (const bad of ["", "0", "61", "2.5", "abc"]) expect(feedSyncIntervalMs(bad)).toBe(5 * 60_000);
  });

  it("looks at the last 7 days", () => {
    expect(now.getTime() - windowStart(now).getTime()).toBe(SYNC_WINDOW_MS);
    expect(SYNC_WINDOW_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it("is due one interval later, plus a spread of at most a fifth of it (never more than 2 minutes)", () => {
    expect(nextSyncAfter(now, 0).getTime() - now.getTime()).toBe(SYNC_INTERVAL_MS);
    expect(nextSyncAfter(now, 0.999).getTime() - now.getTime()).toBeLessThan(SYNC_INTERVAL_MS + 2 * 60_000);
    expect(nextSyncAfter(now, 0.999).getTime() - now.getTime()).toBeLessThanOrEqual(SYNC_INTERVAL_MS * 1.2);
    expect(nextSyncAfter(now, 0.5).getTime()).toBeGreaterThan(nextSyncAfter(now, 0.1).getTime());
  });
});

describe("planAbsences", () => {
  const since = new Date("2026-10-14T12:00:00Z");
  const row = (id: string, createdHoursAfterSince: number, over: Partial<{ absent_checks: number; missing_since: string | null }> = {}) => ({
    id, facebook_post_id: `fb-${id}`, created_time: new Date(since.getTime() + createdHoursAfterSince * 3_600_000).toISOString(),
    absent_checks: 0, missing_since: null, ...over
  });

  it("a post that is not returned is only suspected the first time, and believed gone the second", () => {
    const known = [row("a", 48), row("b", 48, { absent_checks: 1 })];
    expect(planAbsences(known, new Set(), since)).toEqual({ firstMiss: ["a"], confirmed: ["b"] });
  });

  it("leaves posts that were returned alone", () => {
    expect(planAbsences([row("a", 48)], new Set(["fb-a"]), since)).toEqual({ firstMiss: [], confirmed: [] });
  });

  it("never judges a post at the very edge of the window, which may just have scrolled out", () => {
    expect(planAbsences([row("edge", 0.5), row("inside", 2)], new Set(), since)).toEqual({ firstMiss: ["inside"], confirmed: [] });
  });

  it("does not report a post that is already known to be gone", () => {
    expect(planAbsences([row("gone", 48, { absent_checks: 2, missing_since: "2026-10-20T00:00:00Z" })], new Set(), since)).toEqual({ firstMiss: [], confirmed: [] });
  });
});
