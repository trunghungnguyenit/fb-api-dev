import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: vi.fn() }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { syncPageFeed, type FeedPage } from "@/lib/feed-sync";
import { commentIncreases, seenNeedsUpdate, type KnownFeedRow, type MappedFeedPost } from "@/lib/meta/feed-posts";
import { describeNotification, dedupeKeys } from "@/lib/notification-text";
import { adoptLiveCount, markCommentsSeen } from "@/lib/new-comments";

const NOW = new Date("2026-10-21T12:00:00Z");
const MIN = 60_000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("commentIncreases (pure)", () => {
  const known = (id: string, over: Partial<KnownFeedRow> = {}): KnownFeedRow => ({
    id: `row-${id}`, facebook_post_id: id, created_time: hoursAgo(2), absent_checks: 0, missing_since: null, comments_count: 3, comments_seen_count: 3, ...over
  });
  const read = (id: string, comments_count: number | null) => ({ facebook_post_id: id, created_time: hoursAgo(2), comments_count }) as MappedFeedPost;

  it("reports how many comments a known post gained", () => {
    expect(commentIncreases([known("a")], [read("a", 7)])).toEqual([{ feedPostId: "row-a", facebookPostId: "a", createdTime: hoursAgo(2), added: 4 }]);
  });

  it("says nothing for a post seen for the first time, an unchanged or lower count, or a count either side does not know", () => {
    expect(commentIncreases([], [read("new", 40)])).toEqual([]);
    expect(commentIncreases([known("a")], [read("a", 3)])).toEqual([]);
    expect(commentIncreases([known("a")], [read("a", 1)])).toEqual([]);
    expect(commentIncreases([known("a", { comments_count: null })], [read("a", 9)])).toEqual([]);
    expect(commentIncreases([known("a")], [read("a", null)])).toEqual([]);
    expect(commentIncreases([known("a", { comments_count: undefined })], [read("a", 9)])).toEqual([]);
  });

  it("ignores a post already known to be gone", () => {
    expect(commentIncreases([known("a", { missing_since: hoursAgo(1) })], [read("a", 9)])).toEqual([]);
  });
});

describe("seenNeedsUpdate (pure)", () => {
  it("sets the mark when there is none, or when the count fell below it, and otherwise leaves it", () => {
    expect(seenNeedsUpdate({ comments_seen_count: null }, 5)).toBe(true);
    expect(seenNeedsUpdate({}, 5)).toBe(true);
    expect(seenNeedsUpdate({ comments_seen_count: 5 }, 3)).toBe(true);
    expect(seenNeedsUpdate({ comments_seen_count: 5 }, 5)).toBe(false);
    expect(seenNeedsUpdate({ comments_seen_count: 3 }, 8)).toBe(false);
    expect(seenNeedsUpdate({ comments_seen_count: null }, null)).toBe(false);
  });
});

describe("the notification text", () => {
  it("says how many, about which post, and links to it", () => {
    const text = describeNotification({ type: "NEW_COMMENTS", post_id: "p1", params: { count: 3, feedPostId: "f1", postDate: "2026-10-20T10:00:00Z" } }, "HTStudio");
    expect(text.title).toBe("3 bình luận mới trên HTStudio");
    expect(text.detail).toBe("Bài đăng ngày 20/10/2026. Bấm để xem và trả lời.");
    expect(text.href).toBe("/posts/p1");
  });
  it("links a post that was not published by the app to its Facebook copy, and copes with missing parameters", () => {
    expect(describeNotification({ type: "NEW_COMMENTS", post_id: null, params: { count: 1, feedPostId: "f1" } }).href).toBe("/posts/facebook/f1");
    const bare = describeNotification({ type: "NEW_COMMENTS" });
    expect(bare).toMatchObject({ title: "1 bình luận mới", href: "/posts?source=facebook" });
    expect(describeNotification({ type: "NEW_COMMENTS", params: { count: 2, postDate: "not a date" } }).detail).toBe("Bấm để xem và trả lời.");
  });
  it("starts a new round of notification keys for each read", () => {
    expect(dedupeKeys.newComments("f1", 1)).not.toBe(dedupeKeys.newComments("f1", 2));
    expect(dedupeKeys.newComments("f1", 1)).toBe(dedupeKeys.newComments("f1", 1));
  });
});

// ---- through the real sync -------------------------------------------------------------------------------------------
const page: FeedPage = { id: "pr1", user_id: "u1", page_id: "fb1", page_access_token_encrypted: "enc" };
const graphPost = (n: number, comments: number | null, over: Record<string, unknown> = {}) => ({
  id: `fb1_${n}`, message: `Bài ${n}`, created_time: hoursAgo(n), permalink_url: `https://www.facebook.com/fb1/posts/${n}`, status_type: "added_photos",
  reactions: { summary: { total_count: 0 } }, shares: { count: 0 },
  ...(comments === null ? {} : { comments: { summary: { total_count: comments } } }), ...over
});
const sync = async (minutes: number, ...posts: unknown[]) => {
  metaGet.mockResolvedValue({ data: posts });
  return syncPageFeed(page, new Date(NOW.getTime() + minutes * MIN));
};
const notifications = () => fake.tables.notifications.filter((n) => n.type === "NEW_COMMENTS");
const feed = (n: number) => fake.tables.page_feed_posts.find((p) => p.facebook_post_id === `fb1_${n}`)!;

beforeEach(() => {
  fake.reset();
  metaGet.mockReset();
  fake.tables.facebook_pages.push({ ...page, is_active: true, removed_at: null, feed_next_sync_at: null, feed_synced_at: null, feed_sync_error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("announcing new comments from the sync", () => {
  it("stays quiet for posts seen for the first time, however many comments they already have, and takes that as the starting point", async () => {
    await sync(0, graphPost(1, 12), graphPost(2, 0));
    expect(notifications()).toHaveLength(0);
    expect(feed(1)).toMatchObject({ comments_count: 12, comments_seen_count: 12 });
  });

  it("announces the comments a known post gained, about that post and Page, with no comment text", async () => {
    await sync(0, graphPost(1, 2));
    await sync(5, graphPost(1, 5));
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]).toMatchObject({
      user_id: "u1", page_id: "pr1", params: { count: 3, feedPostId: feed(1).id, postDate: hoursAgo(1) }
    });
    expect(notifications()[0].read_at ?? null).toBeNull();
    expect(feed(1)).toMatchObject({ comments_count: 5, comments_seen_count: 2 }); // 3 not yet seen
  });

  it("adds up while it is unread, bringing the same notification back to the top, instead of piling up new ones", async () => {
    await sync(0, graphPost(1, 2));
    await sync(5, graphPost(1, 5));
    const first = notifications()[0].created_at;
    await sync(10, graphPost(1, 7));
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 5 });
    expect(notifications()[0].created_at).not.toBe(first);
    expect(new Date(String(notifications()[0].created_at)).getTime()).toBe(NOW.getTime() + 10 * MIN);
  });

  it("starts a new notification once the last one was read", async () => {
    await sync(0, graphPost(1, 2));
    await sync(5, graphPost(1, 5));
    notifications()[0].read_at = NOW.toISOString();
    await sync(10, graphPost(1, 6));
    expect(notifications()).toHaveLength(2);
    expect(notifications().map((n) => (n.params as { count: number }).count).sort()).toEqual([1, 3]);
  });

  it("keeps each post on its own, and does not announce an unchanged repeat read", async () => {
    await sync(0, graphPost(1, 1), graphPost(2, 1));
    await sync(5, graphPost(1, 4), graphPost(2, 1));
    await sync(10, graphPost(1, 4), graphPost(2, 1));
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 3, feedPostId: feed(1).id });
  });

  it("does not announce a count that fell (a comment deleted), and the next real comment still counts", async () => {
    await sync(0, graphPost(1, 5));
    await sync(5, graphPost(1, 3));
    expect(notifications()).toHaveLength(0);
    expect(feed(1)).toMatchObject({ comments_count: 3, comments_seen_count: 3 }); // the mark follows the count down
    await sync(10, graphPost(1, 4));
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 1 });
  });

  it("makes no claim when Facebook gave no count (the plain fields fallback), then takes the first count as the starting point", async () => {
    await sync(0, graphPost(1, null));
    await sync(5, graphPost(1, 6));
    expect(notifications()).toHaveLength(0);
    expect(feed(1)).toMatchObject({ comments_count: 6, comments_seen_count: 6 });
  });

  it("links the notification to the app's own post when the post was published by the app", async () => {
    fake.tables.posts.push({ id: "app-post-1", user_id: "u1", facebook_post_id: "fb1_1" });
    await sync(0, graphPost(1, 1));
    await sync(5, graphPost(1, 2));
    expect(notifications()[0]).toMatchObject({ post_id: "app-post-1" });
  });

  it("a failed notification never fails the read", async () => {
    await sync(0, graphPost(1, 1));
    fake.tables.notifications = undefined as never;
    const result = await sync(5, graphPost(1, 3));
    expect(result.status).toBe("synced");
    expect(feed(1).comments_count).toBe(3);
  });
});

describe("announcing new comments: reads that lack the numbers", () => {
  it("a read without the comment count does not erase the stored one, so the next full read still sees the rise", async () => {
    await sync(0, graphPost(1, 5));
    await sync(5, graphPost(1, null)); // the plain-fields fallback: no counts at all
    expect(feed(1).comments_count).toBe(5);
    await sync(10, graphPost(1, 8));
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 3 });
  });
});

describe("adoptLiveCount", () => {
  it("takes the live total as both count and seen mark, so what the user just read is not announced afterwards", async () => {
    await sync(0, graphPost(1, 5));
    await adoptLiveCount("u1", { feedId: String(feed(1).id) }, 7); // the comments list showed 7: two arrived since the last read
    expect(feed(1)).toMatchObject({ comments_count: 7, comments_seen_count: 7 });
    await sync(5, graphPost(1, 7));
    expect(notifications()).toHaveLength(0);
  });

  it("leaves other users' posts alone", async () => {
    await sync(0, graphPost(1, 5));
    await adoptLiveCount("someone-else", { feedId: String(feed(1).id) }, 9);
    expect(feed(1).comments_count).toBe(5);
  });
});

describe("markCommentsSeen", () => {
  it("marks every unread notification of the post as read, even if two overlapping reads made two", async () => {
    await sync(0, graphPost(1, 1));
    await sync(5, graphPost(1, 3));
    fake.tables.notifications.push({ ...notifications()[0], id: "dup", dedupe_key: "new-comments:dup" }); // what a second, overlapping read would leave
    expect(notifications()).toHaveLength(2);
    await markCommentsSeen("u1", { feedId: String(feed(1).id) });
    expect(notifications().every((n) => n.read_at)).toBe(true);
  });

  it("counts the comments as seen and marks that post's notification as read, and nothing else", async () => {
    await sync(0, graphPost(1, 1), graphPost(2, 1));
    await sync(5, graphPost(1, 4), graphPost(2, 3));
    expect(notifications()).toHaveLength(2);

    await markCommentsSeen("u1", { feedId: String(feed(1).id) });
    expect(feed(1)).toMatchObject({ comments_seen_count: 4 });
    expect(feed(2)).toMatchObject({ comments_seen_count: 1 });
    expect(notifications().filter((n) => n.read_at).map((n) => (n.params as { feedPostId: string }).feedPostId)).toEqual([feed(1).id]);
  });

  it("finds the stored copy of the app's own post by its id", async () => {
    fake.tables.posts.push({ id: "app-post-1", user_id: "u1", facebook_post_id: "fb1_1" });
    await sync(0, graphPost(1, 1));
    await sync(5, graphPost(1, 3));
    await markCommentsSeen("u1", { postId: "app-post-1" });
    expect(feed(1)).toMatchObject({ comments_seen_count: 3 });
    expect(notifications()[0].read_at).toBeTruthy();
  });

  it("does nothing for another user's post or a post that is not stored", async () => {
    await sync(0, graphPost(1, 1));
    await sync(5, graphPost(1, 3));
    await markCommentsSeen("someone-else", { feedId: String(feed(1).id) });
    await markCommentsSeen("u1", { feedId: "does-not-exist" });
    expect(feed(1).comments_seen_count).toBe(1);
    expect(notifications()[0].read_at).toBeFalsy();
  });
});
