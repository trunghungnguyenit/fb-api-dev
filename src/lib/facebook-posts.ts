import { decryptSecret } from "@/lib/crypto";
import { one, userDb } from "@/lib/db";
import type { ErrorCode } from "@/lib/errors";
import { MetaApiError, metaDelete, metaGet, metaPost } from "@/lib/meta/client";
import { describeMetaError } from "@/lib/meta/pages";
import { deactivatePage } from "@/lib/page-sync";

// Operations on a post that is ALREADY on Facebook (read live numbers, edit the text, delete).
// Everything here is scoped to the signed-in user and uses that Page's own token.

export type PostEventType =
  | "edited" | "edit_failed" | "deleted_on_facebook" | "delete_failed"
  | "detected_missing" | "detected_live" | "marked_deleted" | "republished";

/** A failure with a user-facing code already chosen. `gone` = the object no longer exists on Facebook. */
export class FacebookActionError extends Error {
  constructor(public code: ErrorCode, public gone = false, cause?: unknown) {
    super(code, { cause });
    this.name = "FacebookActionError";
  }
}

/** `post_type` matters for videos and Reels: their Facebook object is a Video, which has `description` instead of `message`. */
export type FacebookPostRef = { id: string; page_id: string; facebook_post_id: string | null; post_type?: string | null };

const isVideoPost = (post: FacebookPostRef) => post.post_type === "video" || post.post_type === "reel";

/** Graph gives a video's permalink as a path ("/page/videos/123/"); make it a link. */
// Only a web address is ever made a link: anything else Facebook might send (javascript:, data:) becomes no link.
export const absoluteUrl = (url: string | undefined) => {
  if (!url) return null;
  try {
    const full = new URL(url, "https://www.facebook.com");
    return full.protocol === "https:" || full.protocol === "http:" ? full.toString() : null;
  } catch { return null; }
};

/** Best-effort audit log: never throws, never stores content or tokens. */
export async function recordEvent(userId: string, postId: string, type: PostEventType, errorCode?: string | null) {
  const { error } = await userDb(userId).events.insert({ post_id: postId, type, error_code: errorCode ?? null });
  if (error) console.error(`post_events insert failed (${type}) for ${postId}:`, error);
}

/**
 * Meta answers "object does not exist" and "no permission to see it" the same way: code 100 / subcode 33, or (what a
 * deleted post of a Page gets, seen on a real Page) code 10 with "Object does not exist, cannot be loaded due to
 * missing permission or review". The two cannot be told apart, so callers treat it as "gone" only after the Page
 * token was accepted (a dead token is a different error) and the result stays reversible (see detected_live).
 * Other code 10 answers ("requires the pages_read_engagement permission") are real permission problems, not this.
 */
export function isGoneError(error: unknown) {
  if (!(error instanceof MetaApiError)) return false;
  if (error.code === "100" && error.subcode === "33") return true;
  return error.code === "10" && /object does not exist/i.test(error.message);
}

export function classifyFacebookError(error: unknown, op: "read" | "edit" | "delete" | "comment"): FacebookActionError {
  if (error instanceof FacebookActionError) return error;
  if (error instanceof MetaApiError) {
    // For a comment, "does not exist" means the comment (or its post) is gone.
    if (isGoneError(error)) return new FacebookActionError(op === "comment" ? "COMMENT_GONE" : "FB_POST_GONE", true, error);
    const code = describeMetaError(error);
    if (op === "comment" && code === "FB_PERMISSION_DENIED") return new FacebookActionError("COMMENTS_PERMISSION_DENIED", false, error);
    // The generic refusals (also code 100, the usual one for a comment that cannot be liked or edited) talk about posts; for a comment it must talk about the comment.
    if (op === "comment" && (code === "FB_REJECTED" || code === "FB_CONTENT_REJECTED")) return new FacebookActionError("COMMENT_REJECTED", false, error);
    if (op === "delete" && (code === "FB_PERMISSION_DENIED" || code === "FB_REJECTED")) {
      return new FacebookActionError("FB_DELETE_NOT_ALLOWED", false, error);
    }
    if (op === "edit" && code === "FB_REJECTED") return new FacebookActionError("FB_EDIT_REJECTED", false, error);
    return new FacebookActionError(code, false, error);
  }
  // Timeout, network reset, non-JSON body.
  return new FacebookActionError("FB_UNAVAILABLE", false, error);
}

async function pageToken(userId: string, pageRowId: string) {
  const { data, error } = await userDb(userId).pages
    .select("id,page_access_token_encrypted,is_active,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw new FacebookActionError("DB_ERROR", false, error);
  const page = one<{ page_access_token_encrypted: string; is_active: boolean; removed_at: string | null }>(data);
  if (page?.removed_at) throw new FacebookActionError("PAGE_REMOVED_ACTION");
  if (!page || !page.is_active) throw new FacebookActionError("PAGE_INACTIVE");
  try { return decryptSecret(page.page_access_token_encrypted); }
  catch (e) { throw new FacebookActionError("TOKEN_DECRYPT_FAILED", false, e); }
}

/**
 * Failures the user is told about and fixes themselves (a permission to grant, a Page without that section, a post that is gone).
 * They are an answer, not a fault of the app, so they are logged as a warning: an error log (and the error screen of the dev
 * server) is for what nobody expected.
 */
const EXPECTED_FAILURES = new Set<ErrorCode>([
  "GUEST_PERMISSION_DENIED", "GUEST_SCOPES_MISSING", "GUEST_POSTS_UNAVAILABLE", "RATINGS_UNAVAILABLE", "COMMENTS_PERMISSION_DENIED",
  "COMMENTS_SCOPES_MISSING", "COMMENT_GONE", "COMMENT_NOT_OWN", "INSIGHTS_PERMISSION_DENIED", "INSIGHTS_SCOPES_MISSING", "INSIGHTS_NO_ANALYZE",
  "INSIGHTS_POST_UNAVAILABLE", "REACTIONS_PERMISSION_DENIED", "REACTIONS_POST_UNAVAILABLE", "FB_POST_GONE", "FB_PERMISSION_DENIED"
]);

/** What Facebook said, as one line of data: the wrapper's own cause when there is one (so the log shows Facebook's answer, not our wrapper). */
function whatFacebookSaid(e: unknown) {
  const source = e instanceof FacebookActionError && e.cause !== undefined ? e.cause : e;
  return source instanceof MetaApiError ? { code: source.code, subcode: source.subcode, trace: source.traceId, message: source.message } : source;
}

/**
 * Runs `fn` with the Page's own token. Any failure becomes a FacebookActionError with a user-facing code; a dead token
 * switches the Page off (its queued posts stay queued), same as the publisher does. `what` only labels the log line.
 */
export async function runWithPageToken<T>(
  userId: string, pageRowId: string, op: "read" | "edit" | "delete" | "comment", what: string, fn: (token: string) => Promise<T>
): Promise<T> {
  const token = await pageToken(userId, pageRowId);
  try {
    return await fn(token);
  } catch (e) {
    const failure = classifyFacebookError(e, op);
    if (failure.code === "PAGE_PERMISSION_LOST") await deactivatePage(userId, pageRowId);
    (EXPECTED_FAILURES.has(failure.code) ? console.warn : console.error)(`facebook ${op} failed for ${what} (${failure.code}):`, whatFacebookSaid(e));
    throw failure;
  }
}

async function withPageToken<T>(
  userId: string, post: FacebookPostRef, op: "read" | "edit" | "delete", fn: (token: string, facebookPostId: string) => Promise<T>
): Promise<T> {
  if (!post.facebook_post_id) throw new FacebookActionError("POST_NO_FACEBOOK_ID");
  const facebookPostId = post.facebook_post_id;
  return runWithPageToken(userId, post.page_id, op, `post ${post.id}`, (token) => fn(token, facebookPostId));
}

export type LiveStats = {
  permalinkUrl: string | null;
  message: string | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
};

type GraphPost = {
  message?: string;
  permalink_url?: string;
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
};

/** Live numbers from Facebook. Throws FacebookActionError (`gone` when the post no longer exists). */
export async function readFacebookPost(userId: string, post: FacebookPostRef): Promise<LiveStats> {
  return withPageToken(userId, post, "read", async (token, id) => {
    if (isVideoPost(post)) {
      const video = await metaGet<{ description?: string; permalink_url?: string }>(id, token, { fields: "description,permalink_url" });
      // Which engagement fields a Video node offers is thinly documented, so a refusal leaves the numbers empty
      // instead of failing the whole read (the post itself was found).
      let reactions: number | null = null;
      let comments: number | null = null;
      try {
        const e = await metaGet<GraphPost>(id, token, { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" });
        reactions = e.reactions?.summary?.total_count ?? 0;
        comments = e.comments?.summary?.total_count ?? 0;
      } catch (error) {
        if (!(error instanceof MetaApiError && error.code === "100")) throw error;
      }
      return { permalinkUrl: absoluteUrl(video.permalink_url), message: video.description ?? null, reactions, comments, shares: null };
    }
    const g = await metaGet<GraphPost>(id, token, {
      fields: "message,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares"
    });
    return {
      permalinkUrl: absoluteUrl(g.permalink_url),
      message: g.message ?? null,
      reactions: g.reactions?.summary?.total_count ?? 0,
      comments: g.comments?.summary?.total_count ?? 0,
      shares: g.shares?.count ?? 0
    };
  });
}

/**
 * Edits the text of a published post. Only `message` can change (link, Page and time cannot).
 * Editing is idempotent, so on a timeout we read the post back to learn whether the edit applied.
 */
export async function editFacebookMessage(userId: string, post: FacebookPostRef, message: string) {
  await withPageToken(userId, post, "edit", async (token, id) => {
    const field = isVideoPost(post) ? "description" : "message";
    try {
      const result = await metaPost<{ success?: boolean }>(id, token, { [field]: message });
      if (result?.success === false) throw new FacebookActionError("FB_EDIT_REJECTED");
    } catch (e) {
      if (e instanceof MetaApiError || e instanceof FacebookActionError) throw e;
      const live = await metaGet<{ message?: string; description?: string }>(id, token, { fields: field });
      if ((isVideoPost(post) ? live.description : live.message) !== message) throw e;
    }
  });
}

/** Deletes the post on Facebook (irreversible). A post that is already gone counts as deleted. */
export async function deleteFacebookPost(userId: string, post: FacebookPostRef) {
  try {
    await withPageToken(userId, post, "delete", async (token, id) => {
      const result = await metaDelete<{ success?: boolean }>(id, token);
      if (result?.success === false) throw new FacebookActionError("FB_DELETE_NOT_ALLOWED");
    });
  } catch (e) {
    if (e instanceof FacebookActionError && e.gone) return;
    throw e;
  }
}

/** True when Facebook confirms the post no longer exists; false when it is still live. */
export async function isGoneOnFacebook(userId: string, post: FacebookPostRef) {
  try {
    await readFacebookPost(userId, post);
    return false;
  } catch (e) {
    if (e instanceof FacebookActionError && e.gone) return true;
    throw e;
  }
}

/** The post is gone from Facebook (deleted by us, or found missing). The row stays as an audit trail. */
export async function markFacebookGone(userId: string, postId: string, type: PostEventType) {
  const { error } = await userDb(userId).posts
    .update({ facebook_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", postId).is("facebook_deleted_at", null);
  if (error) console.error(`markFacebookGone failed for ${postId}:`, error);
  await recordEvent(userId, postId, type);
}

/** Facebook shows the post again after we had marked it gone (the "gone" signal is not fully reliable). */
export async function clearFacebookGone(userId: string, postId: string) {
  const { error } = await userDb(userId).posts
    .update({ facebook_deleted_at: null, updated_at: new Date().toISOString() })
    .eq("id", postId).not("facebook_deleted_at", "is", null);
  if (error) console.error(`clearFacebookGone failed for ${postId}:`, error);
  await recordEvent(userId, postId, "detected_live");
}
