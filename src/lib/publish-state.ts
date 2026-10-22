import { supabaseAdmin } from "@/lib/supabase/admin";
import { messageFor, type ErrorCode } from "@/lib/errors";

// How a post's state is written while it is being published. Shared by the publisher and the video/Reels follow-up
// (which finishes posts later, from another job), so neither imports the other.

export const AMBIGUOUS_CODE = "AMBIGUOUS" satisfies ErrorCode;

// Graph's "unknown error" (1) and "service unavailable" (2) are often returned with HTTP 4xx even though
// the post was created, so they must not be treated as a definite failure (a retry would duplicate it).
export const AMBIGUOUS_META_CODES = new Set(["1", "2"]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failure whose user-facing code is already known. */
export class PublishError extends Error {
  constructor(public code: ErrorCode, cause?: unknown) {
    super(code, { cause });
  }
}

/**
 * Writes the final post state, retrying: after Facebook accepted a post this write must not be lost.
 * Also ends any video / Reels phase. Returns false (after logging loudly) if no row could be updated.
 */
export async function finalizePost(postId: string, fields: Record<string, unknown>) {
  const patch = { ...fields, locked_at: null, publish_phase: null, processing_since: null, updated_at: new Date().toISOString() };
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin.from("posts").update(patch)
      .eq("id", postId).eq("status", "publishing").select("id");
    if (!error) {
      if (data?.length) return true;
      break; // 0 rows: the post is no longer `publishing` (e.g. reaped); handled below
    }
    lastError = error;
    await sleep(500 * (i + 1));
  }
  // A successful publish must never be lost, even if the reaper already marked the post AMBIGUOUS.
  if (fields.status === "published") {
    const { data } = await supabaseAdmin.from("posts").update(patch)
      .eq("id", postId).eq("status", "failed").eq("last_error_code", AMBIGUOUS_CODE).select("id");
    if (data?.length) return true;
  }
  console.error(`finalizePost updated no row for ${postId}; manual reconciliation needed:`, lastError ?? "post not in expected status", fields);
  return false;
}

/**
 * Nothing was created on Facebook: put a claimed post back in the queue. `flagInactive` also marks it for a
 * deactivated Page; `deferUntil` (epoch ms) keeps it out of the queue until then (rate limit back-off).
 * A Reel's upload session (publish_phase / facebook_video_id) is left alone, so the next attempt resumes it.
 */
export async function requeue(postId: string, flagInactive = false, deferUntil?: number) {
  const { error } = await supabaseAdmin.from("posts").update({
    status: "scheduled", locked_at: null, sent_at: null, updated_at: new Date().toISOString(),
    ...(flagInactive ? { last_error_code: "PAGE_INACTIVE", last_error_message: messageFor("PAGE_INACTIVE") } : {}),
    ...(deferUntil ? { next_attempt_at: new Date(deferUntil).toISOString() } : {})
  }).eq("id", postId).eq("status", "publishing");
  if (error) console.error(`requeue failed for ${postId}:`, error);
}

/** Closes the attempt row that is still `started` for a post (used when a post is finished by a later job). */
export async function closeLatestAttempt(postId: string, fields: Record<string, unknown>) {
  const { data } = await supabaseAdmin.from("publish_attempts").select("id")
    .eq("post_id", postId).eq("outcome", "started").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return;
  const { error } = await supabaseAdmin.from("publish_attempts")
    .update({ ...fields, finished_at: new Date().toISOString() }).eq("id", (data as { id: string }).id);
  if (error) console.error(`closing the attempt of post ${postId} failed:`, error);
}
