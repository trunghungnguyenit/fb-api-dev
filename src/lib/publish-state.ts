import { supabaseAdmin } from "@/lib/supabase/admin";
import { messageFor, type ErrorCode } from "@/lib/errors";

// How a post's state is written while it is being published. Shared by the publisher and the video/Reels follow-up
// (which finishes posts later, from another job), so neither imports the other.

export const AMBIGUOUS_CODE = "AMBIGUOUS" satisfies ErrorCode;

// Graph's "unknown error" (1) and "service unavailable" (2) are often returned with HTTP 4xx even though
// the post was created, so they must not be treated as a definite failure (a retry would duplicate it).
export const AMBIGUOUS_META_CODES = new Set(["1", "2"]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Time budget -------------------------------------------------------------------------------------------------
// Every route that publishes runs under the serverless limit (maxDuration = 60). A function killed after a request
// reached Facebook leaves a post whose outcome nobody knows, so every call to Facebook gets a timeout cut to what is
// left before a `deadline` (epoch ms, undefined = no limit), and a step that cannot finish in time is not started.

/** The serverless function limit (the routes' `maxDuration`). */
export const FUNCTION_LIMIT_MS = 120_000;
/** Kept in reserve after the last call, to write the outcome of the post. */
export const SAFETY_MS = 30_000;
/** The least time one Facebook call needs (a link post was seen taking ~21s): below this, the call is not started. */
export const MIN_SEND_MS = 60_000;

/** Thrown BEFORE anything was sent when there is no time left to do the next step safely: the post goes back in the queue. */
export class DeadlineError extends Error {
  constructor(message = "Not enough time left in this run") {
    super(message);
    this.name = "DeadlineError";
  }
}

export const remainingMs = (deadline?: number) =>
  deadline === undefined ? Infinity : deadline - Date.now();

/** Stops (before sending anything) unless `neededMs` plus the reserve fit before the deadline. */
export function requireTime(deadline: number | undefined, neededMs: number) {
  if (remainingMs(deadline) < neededMs + SAFETY_MS) throw new DeadlineError();
}

/** `wantedMs`, cut so the call ends (with the reserve) before the deadline. */
export const capTimeout = (wantedMs: number, deadline?: number) =>
  Math.max(1_000, Math.min(wantedMs, remainingMs(deadline) - SAFETY_MS));

/** A failure whose user-facing code is already known. */
export class PublishError extends Error {
  constructor(
    public code: ErrorCode,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

/**
 * Writes the final post state, retrying: after Facebook accepted a post this write must not be lost.
 * Also ends any video / Reels phase. Returns false (after logging loudly) if no row could be updated.
 */
export async function finalizePost(
  postId: string,
  fields: Record<string, unknown>,
) {
  const patch = {
    ...fields,
    locked_at: null,
    publish_phase: null,
    processing_since: null,
    updated_at: new Date().toISOString(),
  };
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin
      .from("posts")
      .update(patch)
      .eq("id", postId)
      .eq("status", "publishing")
      .select("id");
    if (!error) {
      if (data?.length) return true;
      break; // 0 rows: the post is no longer `publishing` (e.g. reaped); handled below
    }
    lastError = error;
    await sleep(500 * (i + 1));
  }
  // A successful publish must never be lost, even if the reaper already marked the post AMBIGUOUS.
  if (fields.status === "published") {
    const { data } = await supabaseAdmin
      .from("posts")
      .update(patch)
      .eq("id", postId)
      .eq("status", "failed")
      .eq("last_error_code", AMBIGUOUS_CODE)
      .select("id");
    if (data?.length) return true;
  }
  console.error(
    `finalizePost updated no row for ${postId}; manual reconciliation needed:`,
    lastError ?? "post not in expected status",
    fields,
  );
  return false;
}

/**
 * Nothing was created on Facebook: put a claimed post back in the queue. `flagInactive` also marks it for a
 * deactivated Page; `deferUntil` (epoch ms) keeps it out of the queue until then (rate limit back-off).
 * A Reel's upload session (publish_phase / facebook_video_id) is left alone, so the next attempt resumes it.
 */
export async function requeue(
  postId: string,
  flagInactive = false,
  deferUntil?: number,
) {
  const { error } = await supabaseAdmin
    .from("posts")
    .update({
      status: "scheduled",
      locked_at: null,
      sent_at: null,
      updated_at: new Date().toISOString(),
      ...(flagInactive
        ? {
            last_error_code: "PAGE_INACTIVE",
            last_error_message: messageFor("PAGE_INACTIVE"),
          }
        : {}),
      ...(deferUntil
        ? { next_attempt_at: new Date(deferUntil).toISOString() }
        : {}),
    })
    .eq("id", postId)
    .eq("status", "publishing");
  if (error) console.error(`requeue failed for ${postId}:`, error);
}

/** Closes the attempt row that is still `started` for a post (used when a post is finished by a later job). */
export async function closeLatestAttempt(
  postId: string,
  fields: Record<string, unknown>,
) {
  const { data } = await supabaseAdmin
    .from("publish_attempts")
    .select("id")
    .eq("post_id", postId)
    .eq("outcome", "started")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return;
  const { error } = await supabaseAdmin
    .from("publish_attempts")
    .update({ ...fields, finished_at: new Date().toISOString() })
    .eq("id", (data as { id: string }).id);
  if (error)
    console.error(`closing the attempt of post ${postId} failed:`, error);
}
