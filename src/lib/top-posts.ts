import { one, rows, userDb } from "@/lib/db";

// "Bài nổi bật": the posts of a Fanpage that did best in the last 7 days, from the numbers the feed sync already keeps
// (page_feed_posts). It never calls Facebook: the numbers are as fresh as the last read (about every 5 minutes), and 7 days
// is exactly the window that read keeps up to date, so no number here is older than the sync interval.

export type TopSort = "total" | "reactions" | "comments" | "shares";

export const TOP_SORTS: readonly { value: TopSort; label: string }[] = [
  { value: "total", label: "Tổng tương tác" },
  { value: "reactions", label: "Cảm xúc" },
  { value: "comments", label: "Bình luận" },
  { value: "shares", label: "Chia sẻ" }
];

export const TOP_WINDOW_DAYS = 7;
export const TOP_LIMIT = 10;
// Newest first, before ranking: a Fanpage with more than this many posts in 7 days could lose a top post older than the newest 500.
const READ_LIMIT = 500;

/** The sort asked for in the address bar; anything unknown is the default. */
export const parseTopSort = (value: unknown): TopSort => TOP_SORTS.find((s) => s.value === value)?.value ?? "total";

export type FeedRowForTop = {
  id: string; message: string; created_time: string; permalink_url: string | null; status_type: string | null; post_id: string | null;
  reactions_count: number | null; comments_count: number | null; shares_count: number | null;
};

export type TopPost = {
  id: string; message: string; createdTime: string; permalinkUrl: string | null; statusType: string | null;
  /** The app's own post when the app published it (its page is the better link). */
  appPostId: string | null;
  reactions: number; comments: number; shares: number; total: number;
};

const n = (value: number | null) => (typeof value === "number" && value > 0 ? value : 0);

/** Best first by `sort`, newest first among equals; posts with nothing in that column are not "top" and are left out. */
export function rankPosts(list: readonly FeedRowForTop[], sort: TopSort, limit = TOP_LIMIT): TopPost[] {
  return list
    .map((r): TopPost => {
      const reactions = n(r.reactions_count), comments = n(r.comments_count), shares = n(r.shares_count);
      return {
        id: r.id, message: r.message, createdTime: r.created_time, permalinkUrl: r.permalink_url, statusType: r.status_type, appPostId: r.post_id,
        reactions, comments, shares, total: reactions + comments + shares
      };
    })
    .filter((p) => p[sort] > 0)
    .sort((a, b) => b[sort] - a[sort] || b.createdTime.localeCompare(a.createdTime) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export type TopPostsResult = { posts: TopPost[]; sort: TopSort; windowDays: number; syncedAt: string | null };

/** The Fanpage's best posts of the last 7 days from the stored copy (deleted posts and other users' posts never appear). */
export async function loadTopPosts(userId: string, pageRowId: string, sort: TopSort, now: Date = new Date()): Promise<TopPostsResult> {
  const db = userDb(userId);
  const since = new Date(now.getTime() - TOP_WINDOW_DAYS * 24 * 3600_000).toISOString();
  const [list, page] = await Promise.all([
    db.feed.select("id,message,created_time,permalink_url,status_type,post_id,reactions_count,comments_count,shares_count")
      .eq("page_id", pageRowId).gte("created_time", since).is("missing_since", null).order("created_time", { ascending: false }).limit(READ_LIMIT),
    db.pages.select("feed_synced_at").eq("id", pageRowId).maybeSingle()
  ]);
  if (list.error) throw list.error;
  if (page.error) throw page.error;
  const stored = rows<FeedRowForTop>(list.data);

  // The sync marks a post missing only after two reads without it: an app post the app already knows is deleted must not wait for that.
  const appIds = [...new Set(stored.map((r) => r.post_id).filter((id): id is string => Boolean(id)))];
  const deleted = new Set<string>();
  if (appIds.length) {
    const { data, error } = await db.posts.select("id").in("id", appIds).not("facebook_deleted_at", "is", null);
    if (error) throw error;
    for (const p of rows<{ id: string }>(data)) deleted.add(p.id);
  }

  return {
    posts: rankPosts(stored.filter((r) => !r.post_id || !deleted.has(r.post_id)), sort),
    sort, windowDays: TOP_WINDOW_DAYS,
    syncedAt: one<{ feed_synced_at: string | null }>(page.data)?.feed_synced_at ?? null
  };
}
