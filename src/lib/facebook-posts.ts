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

export type FacebookPostRef = { id: string; page_id: string; facebook_post_id: string | null };

/** Best-effort audit log: never throws, never stores content or tokens. */
export async function recordEvent(userId: string, postId: string, type: PostEventType, errorCode?: string | null) {
  const { error } = await userDb(userId).events.insert({ post_id: postId, type, error_code: errorCode ?? null });
  if (error) console.error(`post_events insert failed (${type}) for ${postId}:`, error);
}

/**
 * Meta answers code 100 / subcode 33 both for "object does not exist" and "no permission to see it".
 * That cannot be told apart, so callers treat it as "gone" only after the Page token was accepted
 * (a dead token is a different error) and the result stays reversible (see detected_live).
 */
export function isGoneError(error: unknown) {
  return error instanceof MetaApiError && error.code === "100" && error.subcode === "33";
}

export function classifyFacebookError(error: unknown, op: "read" | "edit" | "delete"): FacebookActionError {
  if (error instanceof FacebookActionError) return error;
  if (error instanceof MetaApiError) {
    if (isGoneError(error)) return new FacebookActionError("FB_POST_GONE", true, error);
    const code = describeMetaError(error);
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
    .select("id,page_access_token_encrypted,is_active").eq("id", pageRowId).maybeSingle();
  if (error) throw new FacebookActionError("DB_ERROR", false, error);
  const page = one<{ page_access_token_encrypted: string; is_active: boolean }>(data);
  if (!page || !page.is_active) throw new FacebookActionError("PAGE_INACTIVE");
  try { return decryptSecret(page.page_access_token_encrypted); }
  catch (e) { throw new FacebookActionError("TOKEN_DECRYPT_FAILED", false, e); }
}

async function withPageToken<T>(
  userId: string, post: FacebookPostRef, op: "read" | "edit" | "delete", fn: (token: string, facebookPostId: string) => Promise<T>
): Promise<T> {
  if (!post.facebook_post_id) throw new FacebookActionError("POST_NO_FACEBOOK_ID");
  const token = await pageToken(userId, post.page_id);
  try {
    return await fn(token, post.facebook_post_id);
  } catch (e) {
    const failure = classifyFacebookError(e, op);
    // Dead token: switch the Page off (its queued posts stay queued), same as the publisher does.
    if (failure.code === "PAGE_PERMISSION_LOST") await deactivatePage(userId, post.page_id);
    console.error(`facebook ${op} failed for post ${post.id} (${failure.code}):`,
      e instanceof MetaApiError ? { code: e.code, subcode: e.subcode, trace: e.traceId, message: e.message } : e);
    throw failure;
  }
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
    const g = await metaGet<GraphPost>(id, token, {
      fields: "message,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares"
    });
    return {
      permalinkUrl: g.permalink_url ?? null,
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
    try {
      const result = await metaPost<{ success?: boolean }>(id, token, { message });
      if (result?.success === false) throw new FacebookActionError("FB_EDIT_REJECTED");
    } catch (e) {
      if (e instanceof MetaApiError || e instanceof FacebookActionError) throw e;
      const live = await metaGet<{ message?: string }>(id, token, { fields: "message" });
      if (live.message !== message) throw e;
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
