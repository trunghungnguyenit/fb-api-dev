import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { metaPost, MetaApiError, PUBLISH_TIMEOUT_MS } from "@/lib/meta/client";
import { describeMetaError } from "@/lib/meta/pages";
import { APP_BUCKET, isRateLimitCode, LOCAL_RATE_LIMIT_CODE, USAGE_POLICY, usageTracker } from "@/lib/meta/usage";
import { deactivatePage } from "@/lib/page-sync";
import { messageFor, type ErrorCode } from "@/lib/errors";
import {
  AMBIGUOUS_CODE, AMBIGUOUS_META_CODES, capTimeout, DeadlineError, finalizePost, FUNCTION_LIMIT_MS, MIN_SEND_MS, PublishError,
  remainingMs, requeue, requireTime
} from "@/lib/publish-state";
import { runPublishPool, type PoolOutcome } from "@/lib/publish-pool";
import { resolveProcessingPosts, runVideoPublish, type ResolveStats } from "@/lib/video-publish";
import { notify } from "@/lib/notifications";
import { dedupeKeys } from "@/lib/notification-text";
import {
  createdPostId, feedRequest, MediaProblemError, multiPhotoRequest, preparePublishMedia, recordFacebookMediaId,
  singlePhotoRequest, unpublishedPhotoRequest, type GraphRequest
} from "@/lib/media/publish-media";

type PublishResult = { id: string; result: "published" | "failed" };

// A post stuck in `publishing` longer than this is assumed orphaned (crash/timeout). Far above the worst
// case of one run (budget + one 15s Meta call), so a live run is never reaped under its own feet.
const STALE_PUBLISHING_MS = 10 * 60 * 1000;
// Stop claiming new posts after this long (counted from the start of the run, the video follow-up included).
const DEFAULT_BUDGET_MS = 25_000;
// Every call to Facebook is cut to the time left before the function limit (the `deadline` handed to publishPost),
// and a step that cannot finish in time is not started: so a function is never killed after a request left.
// Posts that need more time than a run has simply continue on the next run (photos already uploaded are reused).
// The follow-up that looks at videos Facebook is processing may use at most this much of the run.
const RESOLVE_BUDGET_MS = 10_000;
// Below this much time left a new post is not even claimed (it stays queued for the next run).
const MIN_START_MS = MIN_SEND_MS + 5_000;
// How many due posts are fetched at a time; users take turns within each window (see publish-pool.ts).
const CANDIDATE_WINDOW = 200;

export { AMBIGUOUS_CODE };

const graphArgs = (request: GraphRequest, token: string, timeoutMs: number) => [request.path, token, request.params, timeoutMs] as const;

/**
 * Recovers orphaned `publishing` posts. Never sent (sent_at null) => back to the queue, it is safe to retry.
 * Sent => outcome unknown, mark AMBIGUOUS: the post may already be live, so it is never re-queued.
 */
async function reapStalePosts() {
  const cutoff = new Date(Date.now() - STALE_PUBLISHING_MS).toISOString();
  const now = new Date().toISOString();

  const { data: requeued, error: requeueError } = await supabaseAdmin.from("posts")
    .update({ status: "scheduled", locked_at: null, updated_at: now })
    .eq("status", "publishing").lt("locked_at", cutoff).is("sent_at", null).select("id");
  if (requeueError) console.error("reapStalePosts (requeue) failed:", requeueError);

  const { data: ambiguous, error: ambiguousError } = await supabaseAdmin.from("posts").update({
    status: "failed", last_error_code: AMBIGUOUS_CODE, last_error_message: messageFor(AMBIGUOUS_CODE),
    locked_at: null, updated_at: now
  }).eq("status", "publishing").lt("locked_at", cutoff).not("sent_at", "is", null)
    // A video / Reel in a phase has an id Facebook can answer for: the follow-up job decides those, nothing is guessed here.
    .is("publish_phase", null).select("id,user_id,page_id");
  if (ambiguousError) console.error("reapStalePosts (ambiguous) failed:", ambiguousError);
  for (const post of ambiguous ?? []) {
    await notify(post.user_id, {
      type: "PUBLISH_AMBIGUOUS", dedupeKey: dedupeKeys.publishAmbiguous(post.id), pageId: post.page_id, postId: post.id, code: AMBIGUOUS_CODE
    });
  }

  const close = (ids: { id: string }[] | null, outcome: string, errorCode: string) =>
    ids?.length ? supabaseAdmin.from("publish_attempts")
      .update({ outcome, error_code: errorCode, finished_at: now })
      .in("post_id", ids.map((p) => p.id)).eq("outcome", "started") : null;
  await Promise.all([close(requeued, "failure", "INTERRUPTED"), close(ambiguous, "ambiguous", AMBIGUOUS_CODE)]);
}

type DuePost = {
  id: string; user_id: string; page_id: string; message: string; link_url: string | null;
  attempt_count: number | null; scheduled_at: string;
  /** text | link | photo | photos | video | reel (rows from before media existed read as text). */
  post_type?: string;
  /** A Reel whose upload was started by an earlier attempt resumes from it. */
  facebook_video_id?: string | null;
};

const DUE_COLUMNS = "id,user_id,page_id,message,link_url,attempt_count,scheduled_at,post_type,facebook_video_id";

/** Due `scheduled` posts. Posts of a deactivated Page stay queued but are skipped until reconnect clears the flag. */
function dueQuery(dueBeforeIso: string) {
  return supabaseAdmin.from("posts").select(DUE_COLUMNS)
    .eq("status", "scheduled").lte("scheduled_at", dueBeforeIso)
    .or("last_error_code.is.null,last_error_code.neq.PAGE_INACTIVE");
}

/**
 * Publishes ONE due post: claims it, sends it to Facebook and records the outcome. It reports what happened
 * (and whether its Page should be left alone for now) instead of throwing, so the scheduler can keep going.
 */
export async function publishPost(post: DuePost, opts: { deadline?: number } = {}): Promise<PoolOutcome> {
  const { deadline } = opts;
  // No time to even start: leave it queued, untouched, for the next run.
  if (remainingMs(deadline) < MIN_START_MS) return { result: "requeued" };

  // The conditional update is the atomic claim: only one worker can move scheduled -> publishing.
  const { data: claimed, error: claimError } = await supabaseAdmin.from("posts").update({
    status: "publishing", locked_at: new Date().toISOString(), sent_at: null,
    attempt_count: (post.attempt_count ?? 0) + 1, next_attempt_at: null, updated_at: new Date().toISOString()
  }).eq("id", post.id).eq("status", "scheduled").select("id").maybeSingle();

  if (claimError) { console.error(`claim failed for ${post.id}:`, claimError); return { result: "lost" }; }
  if (!claimed) return { result: "lost" };

  const attemptNumber = (post.attempt_count ?? 0) + 1;
  const { data: page, error: pageError } = await supabaseAdmin.from("facebook_pages")
    .select("page_id,page_access_token_encrypted")
    .eq("id", post.page_id).eq("user_id", post.user_id).eq("is_active", true).maybeSingle();

  if (pageError) {
    // Transient DB error before anything was sent: safe to put the post back in the queue.
    console.error(`page lookup failed for post ${post.id}:`, pageError);
    await requeue(post.id);
    return { result: "requeued" };
  }

  const { data: attempt, error: attemptError } = await supabaseAdmin.from("publish_attempts").insert({
    post_id: post.id, user_id: post.user_id, attempt_number: attemptNumber, outcome: "started"
  }).select("id").single();
  if (attemptError) console.error(`publish_attempts insert failed for ${post.id}:`, attemptError);

  const closeAttempt = (fields: Record<string, unknown>) => attempt
    ? supabaseAdmin.from("publish_attempts").update({ ...fields, finished_at: new Date().toISOString() }).eq("id", attempt.id)
    : null;

  let sent = false;
  try {
    if (!page) {
      // Page switched off (or disconnected) since the post was queued: keep it queued, report PAGE_INACTIVE.
      // The rest of this Page's posts would bounce the same way, so the scheduler leaves the Page alone this run.
      await requeue(post.id, true);
      await closeAttempt({ outcome: "failure", error_code: "PAGE_INACTIVE" });
      return { result: "requeued", blockPageUntil: Infinity };
    }
    let token: string;
    try { token = decryptSecret(page.page_access_token_encrypted); }
    catch (e) { throw new PublishError("TOKEN_DECRYPT_FAILED", e); }

    // Marker written BEFORE the request that creates the post leaves: lets the reaper tell "never sent" from "outcome unknown".
    const markSent = async () => {
      const { error: markError } = await supabaseAdmin.from("posts")
        .update({ sent_at: new Date().toISOString() }).eq("id", post.id).eq("status", "publishing");
      if (markError) throw new PublishError("DB_ERROR", markError);
      sent = true;
    };

    let facebookPostId: string | undefined;
    if (post.post_type === "video" || post.post_type === "reel") {
      // Several steps on Facebook's side, and possibly minutes of processing: see video-publish.ts.
      const outcome = await runVideoPublish({ post: { ...post, post_type: post.post_type }, pageFbId: page.page_id, token, markSent, deadline });
      if (outcome.result === "deferred") {
        // Facebook allows 30 Reels per Page per 24 hours: the post waits in the queue, nothing was created.
        await requeue(post.id, false, outcome.until);
        await closeAttempt({ outcome: "failure", error_code: "REELS_DAILY_LIMIT" });
        return { result: "requeued" };
      }
      // Still processing: the follow-up job finishes it (the attempt stays open until then).
      if (outcome.result === "processing") return { result: "processing" };
      facebookPostId = outcome.facebookPostId;
    } else {
    // What to send. Images are re-checked against storage and the current limits first, and (several images) uploaded
    // to Facebook UNPUBLISHED: nothing is visible and a retry reuses them, so none of this can create a duplicate post.
    let request: GraphRequest;
    if (post.post_type === "photo" || post.post_type === "photos") {
      let photos;
      try { photos = await preparePublishMedia(post); }
      catch (e) { throw e instanceof MediaProblemError ? new PublishError(e.code, e.cause ?? e) : e; }
      if (post.post_type === "photo") request = singlePhotoRequest(page.page_id, photos[0].url, post.message);
      else {
        for (const photo of photos) {
          if (photo.facebook_media_id) continue;
          // Out of time: stop here, nothing public exists yet and the photos done so far are remembered for the next run.
          requireTime(deadline, MIN_SEND_MS);
          const uploaded = await metaPost<{ id?: string }>(
            ...graphArgs(unpublishedPhotoRequest(page.page_id, photo.url), token, capTimeout(PUBLISH_TIMEOUT_MS, deadline)));
          if (!uploaded.id) throw new Error("Meta returned success without a photo id");
          photo.facebook_media_id = uploaded.id;
          await recordFacebookMediaId(photo.id, uploaded.id);
        }
        request = multiPhotoRequest(page.page_id, post.message, photos.map((photo) => photo.facebook_media_id as string));
      }
    } else {
      request = feedRequest(page.page_id, post);
    }

    requireTime(deadline, MIN_SEND_MS);
    await markSent();
    const result = await metaPost<{ id?: string; post_id?: string }>(...graphArgs(request, token, capTimeout(PUBLISH_TIMEOUT_MS, deadline)));
    facebookPostId = createdPostId(result);
    }
    if (!facebookPostId) throw new Error("Meta returned success without a post id");

    // The Facebook id goes to the attempt row in parallel with the post update, so it is recorded even if
    // the post update needs retries.
    await Promise.all([
      closeAttempt({ outcome: "success", facebook_post_id: facebookPostId }),
      finalizePost(post.id, {
        status: "published", published_at: new Date().toISOString(),
        facebook_post_id: facebookPostId, last_error_code: null, last_error_message: null
      })
    ]);
    return { result: "published" };
  } catch (error) {
    const metaError = error instanceof MetaApiError ? error : null;
    const technical = error instanceof Error ? error.message : String(error);

    // Ran out of time before anything was sent: back in the queue, the next run continues.
    if (error instanceof DeadlineError && !sent) {
      await requeue(post.id);
      await closeAttempt({ outcome: "failure", error_code: "TIME_BUDGET" });
      return { result: "requeued" };
    }

    // Nothing was sent and the DB hiccuped: retry on the next tick rather than failing the post.
    if (error instanceof PublishError && (error.code === "DB_ERROR" || error.code === "MEDIA_STORAGE_ERROR")) {
      console.error(`publish aborted for post ${post.id} (${error.code} before send):`, error.cause);
      await requeue(post.id);
      await closeAttempt({ outcome: "failure", error_code: error.code, error_message: technical.slice(0, 1000) });
      return { result: "requeued" };
    }

    // Rate limited, either by Meta's answer or by our own back-off before anything was sent: nothing was
    // created, so the post waits in the queue until calls may resume instead of failing.
    if (metaError && (isRateLimitCode(metaError.code) || metaError.code === LOCAL_RATE_LIMIT_CODE)) {
      const retryAt = metaError.retryAt ?? Date.now() + USAGE_POLICY.defaultBlockMs;
      console.warn(`publish deferred for post ${post.id} (${metaError.code}): retry after ${new Date(retryAt).toISOString()}`);
      await requeue(post.id, false, retryAt);
      await closeAttempt({ outcome: "failure", http_status: metaError.httpStatus, error_code: metaError.code, error_message: technical.slice(0, 1000) });
      return { result: "requeued", blockPageUntil: retryAt };
    }

    // After the request left our server, anything other than a clean Meta 4xx rejection
    // (timeout, network reset, bad JSON, 5xx, Graph codes 1/2) may still have created the post.
    let code: ErrorCode;
    if (error instanceof PublishError) code = error.code;
    else if (sent && (!metaError || metaError.httpStatus >= 500 || AMBIGUOUS_META_CODES.has(metaError.code))) code = AMBIGUOUS_CODE;
    else if (metaError) code = describeMetaError(metaError);
    else code = "PUBLISH_FAILED";
    console.error(`publish failed for post ${post.id} (${code}):`, technical,
      metaError ? { code: metaError.code, subcode: metaError.subcode, trace: metaError.traceId } : "",
      error instanceof PublishError ? error.cause : "");

    // Token is dead (nothing was posted): switch the Page off and keep this post queued, like its siblings.
    const pageLost = code === "PAGE_PERMISSION_LOST";
    if (pageLost) {
      await deactivatePage(post.user_id, post.page_id);
      await requeue(post.id, true);
    } else {
      // The user sees only our Vietnamese message; Meta's raw text stays in publish_attempts / logs.
      const saved = await finalizePost(post.id, {
        status: "failed", last_error_code: code, last_error_message: messageFor(code),
        // A failed Reel's upload session is dead; an unknown outcome keeps the id so it can be looked up.
        ...(code === AMBIGUOUS_CODE ? {} : { facebook_video_id: null })
      });
      if (saved) {
        const base = { pageId: post.page_id, postId: post.id, code };
        await notify(post.user_id, code === AMBIGUOUS_CODE
          ? { ...base, type: "PUBLISH_AMBIGUOUS", dedupeKey: dedupeKeys.publishAmbiguous(post.id) }
          : { ...base, type: "PUBLISH_FAILED", dedupeKey: dedupeKeys.publishFailed(post.id, attemptNumber) });
      }
    }

    await closeAttempt({
      outcome: code === AMBIGUOUS_CODE ? "ambiguous" : "failure", http_status: metaError?.httpStatus ?? null,
      error_code: metaError?.code ?? code, error_message: technical.slice(0, 1000)
    });
    return pageLost ? { result: "requeued", blockPageUntil: Infinity } : { result: "failed" };
  }
}

type DueCursor = { at: string; id: string };

/** The next window of due posts after `cursor`, oldest first (keyset pagination: stable while posts are claimed). */
async function fetchDueBatch(dueBeforeIso: string, cursor: DueCursor | null) {
  let query = dueQuery(dueBeforeIso)
    // A post deferred by a rate limit waits for its time.
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${dueBeforeIso}`);
  if (cursor) query = query.or(`scheduled_at.gt.${cursor.at},and(scheduled_at.eq.${cursor.at},id.gt.${cursor.id})`);
  const { data, error } = await query
    .order("scheduled_at", { ascending: true }).order("id", { ascending: true }).limit(CANDIDATE_WINDOW);
  if (error) throw new Error(`Không truy xuất được hàng đợi: ${error.message}`);
  const posts = (data ?? []) as unknown as DuePost[];
  const last = posts[posts.length - 1];
  return { posts, cursor: last ? { at: last.scheduled_at, id: last.id } : cursor };
}

// Concurrency per lane. Text, link and single-photo posts use "fast"; heavy media posts use "heavy" so a long
// upload cannot hold up the rest.
const LANES = { fast: env.PUBLISH_CONCURRENCY, heavy: env.PUBLISH_HEAVY_CONCURRENCY };
// A single photo is one quick call; several photos, video and Reels are many calls or long uploads.
const laneOf = (post: DuePost) => (post.post_type === "photos" || post.post_type === "video" || post.post_type === "reel" ? "heavy" : "fast");

/**
 * One scheduler run: reaps orphaned posts, then publishes due posts in parallel (see publish-pool.ts for the
 * rules) until none are left or the time budget is used. `stats.hasMore` with stopReason "budget" means the
 * caller may run again right away.
 */
export async function runPublishCycle(opts: { limit?: number; budgetMs?: number } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + FUNCTION_LIMIT_MS;
  await reapStalePosts();
  // Videos / Reels that Facebook was still processing earlier: finish the ones that are decided now. Never fatal here.
  // Time-boxed: it counts against the run's budget like everything else.
  let videos: ResolveStats | null = null;
  try { videos = await resolveProcessingPosts({ deadline: startedAt + RESOLVE_BUDGET_MS }); }
  catch (e) { console.error("resolving processing videos failed:", e); }
  const dueBefore = new Date().toISOString();
  const results: PublishResult[] = [];
  const stats = await runPublishPool<DuePost, DueCursor>({
    fetchBatch: (cursor) => fetchDueBatch(dueBefore, cursor),
    publish: async (post) => {
      const outcome = await publishPost(post, { deadline });
      if (outcome.result === "published" || outcome.result === "failed") results.push({ id: post.id, result: outcome.result });
      return outcome;
    },
    concurrency: LANES, laneOf,
    budgetMs: (opts.budgetMs ?? DEFAULT_BUDGET_MS) - (Date.now() - startedAt), limit: opts.limit,
    // Meta has rate limited the whole app: every post would just be deferred again, so stop and try next tick.
    shouldPause: () => Boolean(usageTracker.gate(APP_BUCKET).blockedUntil)
  });
  return { results, stats, videos };
}

/** Publishes due `scheduled` posts (or only one post by id, for "publish now" / retry). Returns what was done. */
export async function processDuePosts(opts: { postId?: string; limit?: number; budgetMs?: number; deadline?: number } = {}) {
  if (!opts.postId) return (await runPublishCycle(opts)).results;
  // The web request that called this has its own function limit: leave it a little for what it does around this call.
  const deadline = opts.deadline ?? Date.now() + FUNCTION_LIMIT_MS - 3_000;

  // A single-post run must not trigger the global sweep, and ignores a rate-limit deferral: the local gate in
  // metaRequest still protects Meta and defers it again if the limit is really still on.
  const { data, error } = await dueQuery(new Date().toISOString()).eq("id", opts.postId).limit(1);
  if (error) throw new Error(`Không truy xuất được hàng đợi: ${error.message}`);
  const results: PublishResult[] = [];
  for (const post of (data ?? []) as unknown as DuePost[]) {
    // A video / Reel takes minutes (upload, then Facebook converts it): never inline in a web request. It stays queued
    // and the scheduler's heavy lane publishes it.
    if (post.post_type === "video" || post.post_type === "reel") continue;
    const outcome = await publishPost(post, { deadline });
    if (outcome.result === "published" || outcome.result === "failed") results.push({ id: post.id, result: outcome.result });
  }
  return results;
}
