import { one, rows, userDb } from "@/lib/db";
import { FacebookActionError, runWithPageToken } from "@/lib/facebook-posts";
import { MetaApiError, metaDelete, metaGet, metaPost } from "@/lib/meta/client";
import {
  COMMENT_FIELDS_BASIC, COMMENT_FIELDS_FULL, COMMENT_ID_PATTERN, COMMENT_MAX_LENGTH, COMMENTS_PAGE_SIZE, mapComments,
  type CommentView, type GraphComment
} from "@/lib/meta/comments";
import { COMMENT_MANAGE_SCOPES, COMMENT_READ_SCOPES, hasScopes } from "@/lib/meta/scopes";

// Reading and moderating the comments on a Fanpage post. Everything runs with the Page's own token, scoped to the
// signed-in user. Comment TEXT is only passed through to the screen: what is stored is a log of what the user did.

export type CommentTarget = {
  kind: "app" | "feed";
  /** posts.id (kind app) or page_feed_posts.id (kind feed). */
  id: string;
  pageRowId: string;
  facebookPageId: string;
  /** Facebook's id of the post (for a video or Reel, of the video). */
  facebookPostId: string;
  access: { read: boolean; manage: boolean };
};

export type ResolveFailure = "POST_NOT_FOUND" | "COMMENTS_UNAVAILABLE" | "PAGE_REMOVED_ACTION" | "PAGE_INACTIVE" | "DB_ERROR";

/** The post and Page a comments request is about, checked to be the user's, live on Facebook, and on a usable Page. */
export async function resolveCommentTarget(
  userId: string, kind: "app" | "feed", id: string
): Promise<{ ok: true; target: CommentTarget } | { ok: false; code: ResolveFailure }> {
  const db = userDb(userId);
  let pageRowId: string;
  let facebookPostId: string | null;
  if (kind === "app") {
    const { data, error } = await db.posts.select("id,page_id,status,facebook_post_id,facebook_deleted_at").eq("id", id).maybeSingle();
    if (error) return { ok: false, code: "DB_ERROR" };
    const post = one<{ page_id: string; status: string; facebook_post_id: string | null; facebook_deleted_at: string | null }>(data);
    if (!post) return { ok: false, code: "POST_NOT_FOUND" };
    if (post.status !== "published" || post.facebook_deleted_at) return { ok: false, code: "COMMENTS_UNAVAILABLE" };
    pageRowId = post.page_id; facebookPostId = post.facebook_post_id;
  } else {
    const { data, error } = await db.feed.select("id,page_id,facebook_post_id,missing_since").eq("id", id).maybeSingle();
    if (error) return { ok: false, code: "DB_ERROR" };
    const post = one<{ page_id: string; facebook_post_id: string; missing_since: string | null }>(data);
    if (!post) return { ok: false, code: "POST_NOT_FOUND" };
    if (post.missing_since) return { ok: false, code: "COMMENTS_UNAVAILABLE" };
    pageRowId = post.page_id; facebookPostId = post.facebook_post_id;
  }
  if (!facebookPostId) return { ok: false, code: "COMMENTS_UNAVAILABLE" };

  const { data: pageData, error: pageError } = await db.pages.select("id,page_id,connection_id,is_active,removed_at").eq("id", pageRowId).maybeSingle();
  if (pageError) return { ok: false, code: "DB_ERROR" };
  const page = one<{ id: string; page_id: string; connection_id: string; is_active: boolean; removed_at: string | null }>(pageData);
  if (!page) return { ok: false, code: "POST_NOT_FOUND" };
  if (page.removed_at) return { ok: false, code: "PAGE_REMOVED_ACTION" };
  if (!page.is_active) return { ok: false, code: "PAGE_INACTIVE" };

  const { data: connectionData, error: connectionError } = await db.connections.select("scopes").eq("id", page.connection_id).maybeSingle();
  if (connectionError) return { ok: false, code: "DB_ERROR" };
  const scopes = one<{ scopes: string[] | null }>(connectionData)?.scopes ?? [];
  return {
    ok: true,
    target: {
      kind, id, pageRowId, facebookPageId: page.page_id, facebookPostId,
      access: { read: hasScopes(scopes, COMMENT_READ_SCOPES), manage: hasScopes(scopes, COMMENT_MANAGE_SCOPES) }
    }
  };
}

const requireRead = (t: CommentTarget) => { if (!t.access.read) throw new FacebookActionError("COMMENTS_SCOPES_MISSING"); };
const requireManage = (t: CommentTarget) => { if (!t.access.manage) throw new FacebookActionError("COMMENTS_SCOPES_MISSING"); };

export type CommentsPage = { comments: CommentView[]; next: string | null; total: number | null; access: CommentTarget["access"] };

/**
 * One page of comments, newest first (replies of a comment: oldest first). `parentId` lists the replies to that comment.
 * `next` is a cursor for the following page, or null at the end.
 */
export async function listComments(userId: string, target: CommentTarget, opts: { after?: string; parentId?: string } = {}): Promise<CommentsPage> {
  requireRead(target);
  if (opts.parentId && !COMMENT_ID_PATTERN.test(opts.parentId)) throw new FacebookActionError("INVALID_REQUEST");
  const path = `${opts.parentId ?? target.facebookPostId}/comments`;

  return runWithPageToken(userId, target.pageRowId, "comment", `comments of ${target.kind} post ${target.id}`, async (token) => {
    let fields = COMMENT_FIELDS_FULL;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await metaGet<{ data?: GraphComment[]; paging?: { cursors?: { after?: string }; next?: string }; summary?: { total_count?: number } }>(path, token, {
          fields, limit: String(COMMENTS_PAGE_SIZE), filter: "toplevel", summary: "1",
          order: opts.parentId ? "chronological" : "reverse_chronological", ...(opts.after ? { after: opts.after } : {})
        });
        return {
          comments: mapComments(res.data),
          // `paging.next` carries the access token, so only the cursor goes back to the browser.
          next: res.paging?.next ? res.paging.cursors?.after ?? null : null,
          total: typeof res.summary?.total_count === "number" ? res.summary.total_count : null,
          access: target.access
        };
      } catch (e) {
        // A refused field (100): ask again for the plain comment, once.
        if (e instanceof MetaApiError && e.code === "100" && e.subcode !== "33" && fields === COMMENT_FIELDS_FULL && attempt === 0) { fields = COMMENT_FIELDS_BASIC; continue; }
        throw e;
      }
    }
  });
}

export type CommentAction = "reply" | "hide" | "unhide" | "delete";

/** Writes the log of what the user did. Best effort like the post log: it never throws and never holds any text. */
async function recordCommentAction(
  userId: string, target: CommentTarget, commentId: string, action: CommentAction, result: "success" | "failed",
  extra: { errorCode?: string; resultCommentId?: string } = {}
) {
  try {
    const { error } = await userDb(userId).commentActions.insert({
      page_id: target.pageRowId, facebook_page_id: target.facebookPageId, post_kind: target.kind, post_ref: target.id,
      facebook_post_id: target.facebookPostId, facebook_comment_id: commentId, action, result,
      error_code: extra.errorCode ?? null, result_comment_id: extra.resultCommentId ?? null
    });
    if (error) console.error(`comment_actions insert failed (${action}):`, error);
  } catch (e) { console.error(`comment_actions insert failed (${action}):`, e); }
}

/** Abuse limit per user, counted from the log so it holds across server instances. */
export const MAX_COMMENT_ACTIONS_PER_MINUTE = 30;

export async function commentActionsRecently(userId: string) {
  const { count, error } = await userDb(userId).commentActions.select("id", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - 60_000).toISOString());
  if (error) throw error;
  return count ?? 0;
}

async function act<T>(
  userId: string, target: CommentTarget, commentId: string, action: CommentAction,
  run: (token: string) => Promise<T>, resultCommentId?: (result: T) => string | undefined
): Promise<T> {
  requireManage(target);
  try {
    const result = await runWithPageToken(userId, target.pageRowId, "comment", `${action} on a comment of ${target.kind} post ${target.id}`, run);
    await recordCommentAction(userId, target, commentId, action, "success", { resultCommentId: resultCommentId?.(result) });
    return result;
  } catch (e) {
    await recordCommentAction(userId, target, commentId, action, "failed", { errorCode: e instanceof FacebookActionError ? e.code : "UNEXPECTED" });
    throw e;
  }
}

/** Replies to a comment (`replyTo`), or adds a comment of the Page to the post. Returns the new comment's id. */
export async function replyToComment(userId: string, target: CommentTarget, message: string, replyTo?: string): Promise<{ id: string }> {
  const text = message.trim();
  if (!text || text.length > COMMENT_MAX_LENGTH) throw new FacebookActionError("INVALID_REQUEST");
  if (replyTo && !COMMENT_ID_PATTERN.test(replyTo)) throw new FacebookActionError("INVALID_REQUEST");
  const objectId = replyTo ?? target.facebookPostId;
  const created = await act(userId, target, replyTo ?? target.facebookPostId, "reply", async (token) => {
    const res = await metaPost<{ id?: string }>(`${objectId}/comments`, token, { message: text });
    if (!res.id) throw new FacebookActionError("FB_REJECTED");
    return res as { id: string };
  }, (r) => r.id);
  return { id: created.id };
}

export async function setCommentHidden(userId: string, target: CommentTarget, commentId: string, hidden: boolean) {
  if (!COMMENT_ID_PATTERN.test(commentId)) throw new FacebookActionError("INVALID_REQUEST");
  await act(userId, target, commentId, hidden ? "hide" : "unhide", async (token) => {
    const res = await metaPost<{ success?: boolean }>(commentId, token, { is_hidden: hidden ? "true" : "false" });
    if (res?.success === false) throw new FacebookActionError("FB_REJECTED");
  });
}

export async function deleteComment(userId: string, target: CommentTarget, commentId: string) {
  if (!COMMENT_ID_PATTERN.test(commentId)) throw new FacebookActionError("INVALID_REQUEST");
  await act(userId, target, commentId, "delete", async (token) => {
    const res = await metaDelete<{ success?: boolean }>(commentId, token);
    if (res?.success === false) throw new FacebookActionError("FB_REJECTED");
  });
}

/** Recent actions of the user, newest first (for support / auditing). Holds no comment text. */
export async function recentCommentActions(userId: string, limit = 50) {
  const { data, error } = await userDb(userId).commentActions
    .select("id,post_kind,facebook_post_id,facebook_comment_id,action,result,error_code,created_at").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return rows<{ id: string; action: CommentAction; result: string; created_at: string }>(data);
}
