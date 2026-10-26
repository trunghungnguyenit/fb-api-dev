import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MediaProblemError, preparePublishMedia } from "@/lib/media/publish-media";
import { downloadObject } from "@/lib/media/storage";
import {
  isMetaUploadUrl, MetaApiError, metaGet, metaPost, metaPostVideoFile, metaUploadBytes, metaUploadFromUrl, reelUploadUrl
} from "@/lib/meta/client";
import { isPermissionError } from "@/lib/meta/pages";
import { isRateLimitCode, LOCAL_RATE_LIMIT_CODE } from "@/lib/meta/usage";
import { interpretVideoStatus, type VideoProgress, type VideoStatus } from "@/lib/meta/video-status";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";
import { deactivatePage } from "@/lib/page-sync";
import { messageFor } from "@/lib/errors";
import {
  AMBIGUOUS_CODE, AMBIGUOUS_META_CODES, capTimeout, closeLatestAttempt, finalizePost, MIN_SEND_MS, PublishError, remainingMs,
  requeue, requireTime, SAFETY_MS, sleep
} from "@/lib/publish-state";

// Publishing a video or a Reel is several steps on Facebook's side and can take minutes, so it does not fit the
// "one request, one answer" shape of a text post. A post goes through these states (publish_phase on the post):
//
//   (none)  ──start (Reels)──▶ uploading ──finish / create──▶ processing ──Facebook says live──▶ published
//                                  │                              │
//                         (crash: resumed, nothing                └─ Facebook says error ──▶ failed
//                          is public yet)                            (or 2 hours of silence ──▶ unknown)
//
// Once Facebook has given us a video id, the outcome is never a guess: we ask Facebook (GET /{video-id}?fields=status).
// The post stays `publishing` while it processes; resolveProcessingPosts() below finishes it, from any later run.

/** Facebook allows 30 API-published Reels per Page per 24 hours (Reels publishing guide). */
export const REELS_PER_DAY = 30;
const REELS_DEFER_MS = 30 * 60 * 1000;
// Wanted timeouts; each call is cut to the time left before the run's deadline (see capTimeout), so on a 60 s function
// a slow upload fails cleanly instead of the whole function being killed after the request left.
const UPLOAD_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The least time worth starting a video / Reel for: a new upload session, or a file handed to Facebook. */
const MIN_START_MS = 30_000;
/** Right after publishing, look a few times (about 15 s) so a small video is finished in the same run. */
const INLINE_POLL_TRIES = 5;
const INLINE_POLL_STEP_MS = 3_000;
/** Between two looks at the same post. */
const POLL_MIN_INTERVAL_MS = 15_000;
/** Facebook still silent after this long: the outcome is unknown (it may be live), so never retry it blindly. */
export const PROCESSING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** A Reel whose upload session was left half-way for this long is checked and resumed. */
const UPLOADING_STALE_MS = 5 * 60 * 1000;

export type VideoPost = {
  id: string; user_id: string; page_id: string; message: string; post_type: "video" | "reel";
  /** Facebook's id when an earlier attempt already started the upload (a Reel resumes instead of starting over). */
  facebook_video_id?: string | null;
};

export type VideoResult =
  | { result: "published"; facebookPostId: string }
  | { result: "processing" }
  | { result: "deferred"; until: number };

/** A rejection that proves nothing was created (a clean 4xx), as opposed to a timeout / 5xx where it may have been. */
const isDefinite = (e: unknown) => e instanceof MetaApiError && e.httpStatus < 500 && !AMBIGUOUS_META_CODES.has(e.code);

export async function fetchProgress(videoId: string, token: string, kind: "video" | "reel"): Promise<VideoProgress> {
  const res = await metaGet<{ status?: VideoStatus }>(videoId, token, { fields: "status" });
  return interpretVideoStatus(res.status, kind);
}

/** Records "Facebook has it and is processing". Retried: after Facebook accepted the video this write must not be lost. */
async function recordProcessing(postId: string, videoId: string) {
  const patch = {
    publish_phase: "processing", facebook_video_id: videoId, processing_since: new Date().toISOString(),
    phase_checked_at: null, locked_at: null, updated_at: new Date().toISOString()
  };
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin.from("posts").update(patch).eq("id", postId).eq("status", "publishing").select("id");
    if (!error && data?.length) return;
    last = error ?? "post not in `publishing`";
    await sleep(400 * (i + 1));
  }
  // The video exists on Facebook but we could not remember its id: the reaper will report the post as unknown.
  console.error(`could not record video ${videoId} for post ${postId}; manual reconciliation may be needed:`, last);
}

async function reelsInLast24h(pageRowId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin.from("posts").select("id", { count: "exact", head: true })
    .eq("page_id", pageRowId).eq("post_type", "reel").in("status", ["publishing", "published"])
    .or(`published_at.gte.${since},status.eq.publishing`);
  if (error) throw new PublishError("DB_ERROR", error);
  return count ?? 0;
}

/**
 * Sends a video or Reel to Facebook. Throws like the text path does (the caller classifies the error, using
 * `markSent` to learn whether Facebook may already have created something), or returns what happened.
 */
export async function runVideoPublish(ctx: {
  post: VideoPost; pageFbId: string; token: string; markSent: () => Promise<void>; mode?: "hosted" | "binary"; pollInline?: boolean;
  /** Epoch ms by which this function must be done (see publish-state.ts). A step that cannot fit throws DeadlineError before sending. */
  deadline?: number;
}): Promise<VideoResult> {
  const { post, pageFbId, token, deadline } = ctx;
  const mode = ctx.mode ?? env.META_VIDEO_UPLOAD_MODE;

  let files;
  try { files = await preparePublishMedia(post); }
  catch (e) { throw e instanceof MediaProblemError ? new PublishError(e.code, e.cause ?? e) : e; }
  const file = files[0];
  if (files.length !== 1 || file.kind !== post.post_type) throw new PublishError("MEDIA_MISSING");

  let videoId: string;
  if (post.post_type === "video") {
    requireTime(deadline, MIN_START_MS);
    // The bytes are fetched BEFORE the post is marked as sent: a failed download proves nothing reached Facebook.
    const bytes = mode === "binary" ? await downloadObject(file.storage_path, capTimeout(UPLOAD_TIMEOUT_MS, deadline)) : null;
    requireTime(deadline, MIN_SEND_MS);
    await ctx.markSent(); // the request below creates the post, so from here on the outcome can be unknown
    const fields: Record<string, string> = post.message ? { description: post.message } : {};
    const timeout = capTimeout(UPLOAD_TIMEOUT_MS, deadline);
    const created = bytes
      ? await metaPostVideoFile<{ id?: string }>(`${pageFbId}/videos`, token, fields,
          { name: file.storage_path.split("/").pop() ?? "video", type: file.mime, data: bytes }, timeout)
      : await metaPost<{ id?: string }>(`${pageFbId}/videos`, token, { file_url: file.url, ...fields }, timeout);
    if (!created.id) throw new Error("Meta returned success without a video id");
    videoId = created.id;
  } else {
    let resumed = Boolean(post.facebook_video_id);
    let uploadUrl: string | undefined;
    if (post.facebook_video_id) videoId = post.facebook_video_id;
    else {
      requireTime(deadline, MIN_START_MS);
      if ((await reelsInLast24h(post.page_id)) > REELS_PER_DAY) return { result: "deferred", until: Date.now() + REELS_DEFER_MS };
      const started = await metaPost<{ video_id?: string; upload_url?: string }>(
        `${pageFbId}/video_reels`, token, { upload_phase: "start" }, capTimeout(REQUEST_TIMEOUT_MS, deadline));
      if (!started.video_id) throw new Error("Meta returned success without a video id");
      videoId = started.video_id;
      uploadUrl = started.upload_url;
      // Remember the session before using it: if we crash from here on, the next attempt resumes instead of starting over.
      const { error } = await supabaseAdmin.from("posts")
        .update({ publish_phase: "uploading", facebook_video_id: videoId, updated_at: new Date().toISOString() })
        .eq("id", post.id).eq("status", "publishing");
      if (error) throw new PublishError("DB_ERROR", error);
    }

    // A resumed session may already have its file: do not send it twice.
    let alreadyUploaded = false;
    if (resumed) {
      const progress = await fetchProgress(videoId, token, "reel");
      if (progress.state === "published") return { result: "published", facebookPostId: videoId };
      if (progress.state === "failed") throw new PublishError("FB_VIDEO_FAILED", progress.reason);
      alreadyUploaded = progress.state === "processing";
      resumed = false;
    }
    if (!alreadyUploaded) {
      const target = uploadUrl && isMetaUploadUrl(uploadUrl) ? uploadUrl : reelUploadUrl(videoId);
      requireTime(deadline, MIN_SEND_MS); // the session is kept: the next attempt resumes it
      if (mode === "binary") {
        const bytes = await downloadObject(file.storage_path, capTimeout(UPLOAD_TIMEOUT_MS, deadline));
        await metaUploadBytes(target, token, bytes, capTimeout(UPLOAD_TIMEOUT_MS, deadline));
      } else await metaUploadFromUrl(target, token, file.url, capTimeout(UPLOAD_TIMEOUT_MS, deadline));
    }

    requireTime(deadline, REQUEST_TIMEOUT_MS); // nothing public yet: out of time here means "resume next run", not "unknown"
    await ctx.markSent(); // the finish call publishes the Reel
    try {
      await metaPost(`${pageFbId}/video_reels`, token, {
        upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", ...(post.message ? { description: post.message } : {})
      }, capTimeout(REQUEST_TIMEOUT_MS, deadline));
    } catch (e) {
      // A clean rejection proves nothing was published. A timeout does not, but we hold the video id, so Facebook can
      // tell us: carry on as "processing" and let the status decide.
      if (isDefinite(e)) throw e;
      console.warn(`finishing Reel ${videoId} did not get a clear answer; waiting for its status:`, e);
    }
  }

  await recordProcessing(post.id, videoId);
  if (ctx.pollInline === false) return { result: "processing" };

  for (let attempt = 0; attempt < INLINE_POLL_TRIES; attempt++) {
    // Looking is optional (the follow-up job does it too): never spend the time the function does not have.
    if (remainingMs(deadline) < INLINE_POLL_STEP_MS + REQUEST_TIMEOUT_MS + SAFETY_MS) break;
    await sleep(INLINE_POLL_STEP_MS);
    let progress: VideoProgress;
    try { progress = await fetchProgress(videoId, token, post.post_type); }
    catch { break; } // a failed look is not a failed post: the follow-up job keeps looking
    if (progress.state === "published") return { result: "published", facebookPostId: videoId };
    if (progress.state === "failed") throw new PublishError("FB_VIDEO_FAILED", progress.reason);
  }
  return { result: "processing" };
}

// ---- The follow-up: finishing posts that Facebook is still processing -------------------------------------------------

export type ResolveStats = { checked: number; published: number; failed: number; resumed: number; unknown: number; waiting: number };

type ProcessingRow = {
  id: string; user_id: string; page_id: string; post_type: "video" | "reel"; facebook_video_id: string | null;
  publish_phase: "uploading" | "processing"; processing_since: string | null; sent_at: string | null; locked_at: string | null;
  attempt_count: number | null;
};

const COLUMNS = "id,user_id,page_id,post_type,facebook_video_id,publish_phase,processing_since,sent_at,locked_at,attempt_count";
const touch = (id: string, extra: Record<string, unknown> = {}) =>
  supabaseAdmin.from("posts").update({ phase_checked_at: new Date().toISOString(), ...extra }).eq("id", id).eq("status", "publishing");

async function resolveOne(row: ProcessingRow, now: Date): Promise<keyof ResolveStats> {
  if (!row.facebook_video_id) return "waiting";
  // A half-finished Reel session is only looked at once it has clearly been abandoned (a live run is not interrupted).
  if (row.publish_phase === "uploading") {
    const abandoned = row.sent_at && row.locked_at && now.getTime() - new Date(row.locked_at).getTime() > UPLOADING_STALE_MS;
    if (!abandoned) return "waiting";
  }
  const timedOut = Boolean(row.processing_since) && now.getTime() - new Date(row.processing_since as string).getTime() > PROCESSING_TIMEOUT_MS;

  const giveUp = async (): Promise<keyof ResolveStats> => {
    // Nothing more can be learned: it may be live, so it is never retried automatically.
    const saved = await finalizePost(row.id, { status: "failed", last_error_code: AMBIGUOUS_CODE, last_error_message: messageFor(AMBIGUOUS_CODE) });
    if (saved) {
      await closeLatestAttempt(row.id, { outcome: "ambiguous", error_code: AMBIGUOUS_CODE });
      await notify(row.user_id, { type: "PUBLISH_AMBIGUOUS", dedupeKey: dedupeKeys.publishAmbiguous(row.id), pageId: row.page_id, postId: row.id, code: AMBIGUOUS_CODE });
    }
    return "unknown";
  };

  const { data: page } = await supabaseAdmin.from("facebook_pages").select("page_access_token_encrypted,is_active")
    .eq("id", row.page_id).eq("user_id", row.user_id).maybeSingle();
  const encrypted = (page as { page_access_token_encrypted?: string } | null)?.page_access_token_encrypted;
  let token: string | null = null;
  try { token = encrypted ? decryptSecret(encrypted) : null; } catch { token = null; }
  if (!token) { await touch(row.id); return timedOut ? giveUp() : "waiting"; }

  let progress: VideoProgress;
  try {
    progress = await fetchProgress(row.facebook_video_id, token, row.post_type);
  } catch (e) {
    const meta = e instanceof MetaApiError ? e : null;
    if (meta && (isRateLimitCode(meta.code) || meta.code === LOCAL_RATE_LIMIT_CODE)) { await touch(row.id); return "waiting"; }
    if (meta && meta.code === "100" && meta.subcode === "33") progress = { state: "failed", reason: "video not found" };
    else {
      if (isPermissionError(e)) await deactivatePage(row.user_id, row.page_id); // the token is dead: nothing can be checked any more
      await touch(row.id);
      return timedOut ? giveUp() : "waiting";
    }
  }

  switch (progress.state) {
    case "published": {
      const saved = await finalizePost(row.id, {
        status: "published", published_at: new Date().toISOString(), facebook_post_id: row.facebook_video_id,
        last_error_code: null, last_error_message: null
      });
      if (saved) await closeLatestAttempt(row.id, { outcome: "success", facebook_post_id: row.facebook_video_id });
      return "published";
    }
    case "failed": {
      const saved = await finalizePost(row.id, {
        status: "failed", last_error_code: "FB_VIDEO_FAILED", last_error_message: messageFor("FB_VIDEO_FAILED"), facebook_video_id: null
      });
      if (saved) {
        console.error(`video ${row.facebook_video_id} of post ${row.id} failed on Facebook: ${progress.reason}`);
        await closeLatestAttempt(row.id, { outcome: "failure", error_code: "FB_VIDEO_FAILED", error_message: progress.reason });
        await notify(row.user_id, {
          type: "PUBLISH_FAILED", dedupeKey: dedupeKeys.publishFailed(row.id, row.attempt_count ?? 1), pageId: row.page_id, postId: row.id, code: "FB_VIDEO_FAILED"
        });
      }
      return "failed";
    }
    case "uploading":
      if (row.publish_phase === "uploading") { await requeue(row.id); return "resumed"; } // the file never fully arrived: send it again
      await touch(row.id);
      return timedOut ? giveUp() : "waiting";
    default:
      // Facebook has the file and is converting it (an abandoned upload whose finish went through lands here too).
      await touch(row.id, row.publish_phase === "uploading"
        ? { publish_phase: "processing", processing_since: new Date().toISOString() } : {});
      return timedOut ? giveUp() : "waiting";
  }
}

/**
 * Looks at the posts whose video / Reel Facebook is still processing (or whose Reel upload was abandoned) and
 * finishes the ones that are decided. Safe to call as often as you like: a post is looked at at most every 15 seconds.
 */
export async function resolveProcessingPosts(opts: { limit?: number; concurrency?: number; now?: Date; deadline?: number } = {}): Promise<ResolveStats> {
  const now = opts.now ?? new Date();
  const stats: ResolveStats = { checked: 0, published: 0, failed: 0, resumed: 0, unknown: 0, waiting: 0 };
  const lookedBefore = new Date(now.getTime() - POLL_MIN_INTERVAL_MS).toISOString();
  const { data, error } = await supabaseAdmin.from("posts").select(COLUMNS)
    .eq("status", "publishing").not("publish_phase", "is", null)
    .or(`phase_checked_at.is.null,phase_checked_at.lt.${lookedBefore}`)
    .order("phase_checked_at", { ascending: true, nullsFirst: true }).limit(opts.limit ?? 20);
  if (error) throw error;
  const queue = [...((data ?? []) as unknown as ProcessingRow[])];

  async function worker() {
    for (let row = queue.shift(); row; row = queue.shift()) {
      // Out of time: the rows left are looked at next run (the query puts the longest-unchecked first).
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      try { stats[await resolveOne(row, now)]++; }
      catch (e) { console.error(`resolving post ${row.id} failed:`, e); stats.waiting++; }
      stats.checked++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, worker));
  return stats;
}
