import { one, rows, userDb } from "@/lib/db";
import type { CommentIncrease } from "@/lib/meta/feed-posts";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";

// "Có N bình luận mới" without webhooks: each feed read stores the comment count of every post of the last 7 days, and a
// count that went up since the previous read means new comments. Only numbers are kept, never the comments' text.
// Everything here is best-effort: telling the user must never fail (or be able to roll back) the read that found it.

type OpenNotification = { id: string; params: { count?: number; feedPostId?: string } | null };

/** The unread "new comments" notifications of a Page, by the stored post they are about (normally one; two overlapping reads can make two). */
async function openNotifications(userId: string, pageRowId: string) {
  const { data, error } = await userDb(userId).notifications.select("id,params")
    .eq("type", "NEW_COMMENTS").eq("page_id", pageRowId).is("read_at", null);
  if (error) throw error;
  const open = new Map<string, OpenNotification[]>();
  for (const n of rows<OpenNotification>(data)) {
    const post = n.params?.feedPostId;
    if (post) open.set(post, [...(open.get(post) ?? []), n]);
  }
  return open;
}

/**
 * One notification per post, adding up while it is unread: new comments raise the count of the open one (and bring it to
 * the top); once the user has read it, the next comments start a new one. Call AFTER the new counts were stored, so a
 * retried read cannot count the same comments twice.
 */
export async function recordNewComments(
  userId: string, pageRowId: string, increases: readonly (CommentIncrease & { appPostId: string | null })[], now: Date
) {
  if (!increases.length) return;
  try {
    const db = userDb(userId);
    const open = await openNotifications(userId, pageRowId);
    for (const inc of increases) {
      const current = open.get(inc.feedPostId)?.[0];
      if (current) {
        const { data, error } = await db.notifications
          .update({ params: { ...current.params, count: (current.params?.count ?? 0) + inc.added }, created_at: now.toISOString() })
          .eq("id", current.id).is("read_at", null).select("id"); // not if the user read it in the meantime
        if (error) throw error;
        if (rows(data).length) continue;
      }
      await notify(userId, {
        type: "NEW_COMMENTS", dedupeKey: dedupeKeys.newComments(inc.feedPostId, now.getTime()), pageId: pageRowId,
        postId: inc.appPostId ?? undefined, params: { count: inc.added, feedPostId: inc.feedPostId, postDate: inc.createdTime }
      });
    }
  } catch (e) {
    console.error(`new comments: recording for page ${pageRowId} failed:`, e);
  }
}

type FeedTarget = { feedId: string } | { postId: string };
type FeedCounts = { id: string; page_id: string; comments_count: number | null; comments_seen_count: number | null };

async function findFeedRow(userId: string, target: FeedTarget): Promise<FeedCounts | null> {
  const query = userDb(userId).feed.select("id,page_id,comments_count,comments_seen_count");
  // limit(1): a post the app published can be linked from more than one stored row (its own id and an attached photo's).
  const { data, error } = await ("feedId" in target ? query.eq("id", target.feedId) : query.eq("post_id", target.postId)).limit(1).maybeSingle();
  if (error) throw error;
  return one<FeedCounts>(data);
}

/** The user opened this post: its comments count as seen, and its "new comments" notification as read. */
export async function markCommentsSeen(userId: string, target: FeedTarget) {
  try {
    const row = await findFeedRow(userId, target);
    if (!row) return;
    const db = userDb(userId);
    if (row.comments_count !== null && row.comments_seen_count !== row.comments_count) {
      const { error } = await db.feed.update({ comments_seen_count: row.comments_count }).eq("id", row.id);
      if (error) throw error;
    }
    const open = (await openNotifications(userId, row.page_id)).get(row.id);
    if (open?.length) {
      const { error } = await db.notifications.update({ read_at: new Date().toISOString() }).in("id", open.map((n) => n.id)).is("read_at", null);
      if (error) throw error;
    }
  } catch (e) {
    console.error("new comments: marking a post as seen failed:", e);
  }
}

/**
 * The user just commented on the post as the Page, from this app: that comment is in the count Facebook will give at the
 * next read, so add it to the stored count (and the seen mark) now. Otherwise the user's own reply would be announced as a
 * "new comment". Only top-level comments: whether a reply to a comment is part of the count is not something Facebook says.
 */
export async function countOwnComment(userId: string, target: FeedTarget) {
  try {
    const row = await findFeedRow(userId, target);
    if (!row || row.comments_count === null) return;
    const patch: Record<string, number> = { comments_count: row.comments_count + 1 };
    if (row.comments_seen_count !== null) patch.comments_seen_count = row.comments_seen_count + 1;
    const { error } = await userDb(userId).feed.update(patch).eq("id", row.id);
    if (error) throw error;
  } catch (e) {
    console.error("new comments: counting the user's own comment failed:", e);
  }
}

/**
 * The comments list of a post was just read from Facebook, so its live total is the best baseline there is: the stored
 * count may be minutes old. Both the count and the seen mark take it, so what the user has just read is not announced as new.
 */
export async function adoptLiveCount(userId: string, target: FeedTarget, total: number) {
  try {
    const row = await findFeedRow(userId, target);
    if (!row || (row.comments_count === total && row.comments_seen_count === total)) return;
    const { error } = await userDb(userId).feed.update({ comments_count: total, comments_seen_count: total }).eq("id", row.id);
    if (error) throw error;
  } catch (e) {
    console.error("new comments: adopting the live count failed:", e);
  }
}
