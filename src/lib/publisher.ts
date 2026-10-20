import { decryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { metaPost, MetaApiError, PUBLISH_TIMEOUT_MS } from "@/lib/meta/client";
import { describeMetaError } from "@/lib/meta/pages";
import { deactivatePage } from "@/lib/page-sync";
import { messageFor, type ErrorCode } from "@/lib/errors";
import { pickFair } from "@/lib/fair-queue";

type PublishResult = { id: string; result: "published" | "failed" };

// A post stuck in `publishing` longer than this is assumed orphaned (crash/timeout). Far above the worst
// case of one run (budget + one 15s Meta call), so a live run is never reaped under its own feet.
const STALE_PUBLISHING_MS = 10 * 60 * 1000;
// Stop claiming new posts after this long. Budget + one slow publish (PUBLISH_TIMEOUT_MS) must stay under the
// serverless maxDuration (60s), so a function is never killed mid-publish.
const DEFAULT_BUDGET_MS = 25_000;
// How many due posts are looked at to pick a fair batch across users.
const CANDIDATE_WINDOW = 200;

export const AMBIGUOUS_CODE = "AMBIGUOUS" satisfies ErrorCode;
// Graph's "unknown error" (1) and "service unavailable" (2) are often returned with HTTP 4xx even though
// the post was created, so they must not be treated as a definite failure (a retry would duplicate it).
const AMBIGUOUS_META_CODES = new Set(["1", "2"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failure whose user-facing code is already known. */
class PublishError extends Error {
  constructor(public code: ErrorCode, cause?: unknown) {
    super(code, { cause });
  }
}

/**
 * Writes the final post state, retrying: after Facebook accepted a post this write must not be lost.
 * Returns false (after logging loudly) if no row could be updated.
 */
async function finalizePost(postId: string, fields: Record<string, unknown>) {
  const patch = { ...fields, locked_at: null, updated_at: new Date().toISOString() };
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

/** Nothing was sent: put a claimed post back in the queue. `flagInactive` also marks it for a deactivated Page. */
async function requeue(postId: string, flagInactive = false) {
  const { error } = await supabaseAdmin.from("posts").update({
    status: "scheduled", locked_at: null, sent_at: null, updated_at: new Date().toISOString(),
    ...(flagInactive ? { last_error_code: "PAGE_INACTIVE", last_error_message: messageFor("PAGE_INACTIVE") } : {})
  }).eq("id", postId).eq("status", "publishing");
  if (error) console.error(`requeue failed for ${postId}:`, error);
}

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
  }).eq("status", "publishing").lt("locked_at", cutoff).not("sent_at", "is", null).select("id");
  if (ambiguousError) console.error("reapStalePosts (ambiguous) failed:", ambiguousError);

  const close = (ids: { id: string }[] | null, outcome: string, errorCode: string) =>
    ids?.length ? supabaseAdmin.from("publish_attempts")
      .update({ outcome, error_code: errorCode, finished_at: now })
      .in("post_id", ids.map((p) => p.id)).eq("outcome", "started") : null;
  await Promise.all([close(requeued, "failure", "INTERRUPTED"), close(ambiguous, "ambiguous", AMBIGUOUS_CODE)]);
}

/** Publishes due `scheduled` posts (optionally only one post by id). */
export async function processDuePosts(opts: { postId?: string; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  // A single-post run (publishNow / retry) must not trigger the global sweep.
  if (!opts.postId) await reapStalePosts();

  let query = supabaseAdmin.from("posts")
    .select("id,user_id,page_id,message,link_url,attempt_count")
    .eq("status", "scheduled").lte("scheduled_at", new Date().toISOString())
    // Posts of a deactivated Page stay queued but are skipped until reconnect clears the flag.
    .or("last_error_code.is.null,last_error_code.neq.PAGE_INACTIVE");
  if (opts.postId) query = query.eq("id", opts.postId);
  const { data: candidates, error } = await query
    .order("scheduled_at", { ascending: true }).limit(opts.postId ? 1 : CANDIDATE_WINDOW);
  if (error) throw new Error(`Không truy xuất được hàng đợi: ${error.message}`);
  const due = opts.postId ? candidates ?? [] : pickFair(candidates ?? [], opts.limit ?? 10);

  const results: PublishResult[] = [];
  for (const post of due) {
    if (!opts.postId && Date.now() - started > budget) break;

    // The conditional update is the atomic claim: only one worker can move scheduled -> publishing.
    const { data: claimed, error: claimError } = await supabaseAdmin.from("posts").update({
      status: "publishing", locked_at: new Date().toISOString(), sent_at: null,
      attempt_count: (post.attempt_count ?? 0) + 1, updated_at: new Date().toISOString()
    }).eq("id", post.id).eq("status", "scheduled").select("id").maybeSingle();

    if (claimError) { console.error(`claim failed for ${post.id}:`, claimError); continue; }
    if (!claimed) continue;

    const attemptNumber = (post.attempt_count ?? 0) + 1;
    const { data: page, error: pageError } = await supabaseAdmin.from("facebook_pages")
      .select("page_id,page_access_token_encrypted")
      .eq("id", post.page_id).eq("user_id", post.user_id).eq("is_active", true).maybeSingle();

    if (pageError) {
      // Transient DB error before anything was sent: safe to put the post back in the queue.
      console.error(`page lookup failed for post ${post.id}:`, pageError);
      await requeue(post.id);
      continue;
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
        await requeue(post.id, true);
        await closeAttempt({ outcome: "failure", error_code: "PAGE_INACTIVE" });
        continue;
      }
      let token: string;
      try { token = decryptSecret(page.page_access_token_encrypted); }
      catch (e) { throw new PublishError("TOKEN_DECRYPT_FAILED", e); }
      const payload: Record<string, string> = { message: post.message };
      if (post.link_url) payload.link = post.link_url;

      // Marker written BEFORE the request leaves: lets the reaper tell "never sent" from "outcome unknown".
      const { error: markError } = await supabaseAdmin.from("posts")
        .update({ sent_at: new Date().toISOString() }).eq("id", post.id).eq("status", "publishing");
      if (markError) throw new PublishError("DB_ERROR", markError);

      sent = true;
      const result = await metaPost<{ id?: string }>(`${page.page_id}/feed`, token, payload, PUBLISH_TIMEOUT_MS);
      if (!result.id) throw new Error("Meta returned success without a post id");
      const facebookPostId = result.id;

      // The Facebook id goes to the attempt row in parallel with the post update, so it is recorded even if
      // the post update needs retries.
      await Promise.all([
        closeAttempt({ outcome: "success", facebook_post_id: facebookPostId }),
        finalizePost(post.id, {
          status: "published", published_at: new Date().toISOString(),
          facebook_post_id: facebookPostId, last_error_code: null, last_error_message: null
        })
      ]);
      results.push({ id: post.id, result: "published" });
    } catch (error) {
      const metaError = error instanceof MetaApiError ? error : null;
      const technical = error instanceof Error ? error.message : String(error);

      // Nothing was sent and the DB hiccuped: retry on the next tick rather than failing the post.
      if (error instanceof PublishError && error.code === "DB_ERROR") {
        console.error(`publish aborted for post ${post.id} (db error before send):`, error.cause);
        await requeue(post.id);
        await closeAttempt({ outcome: "failure", error_code: "DB_ERROR", error_message: technical.slice(0, 1000) });
        continue;
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
      if (code === "PAGE_PERMISSION_LOST") {
        await deactivatePage(post.user_id, post.page_id);
        await requeue(post.id, true);
      } else {
        // The user sees only our Vietnamese message; Meta's raw text stays in publish_attempts / logs.
        await finalizePost(post.id, { status: "failed", last_error_code: code, last_error_message: messageFor(code) });
      }

      await closeAttempt({
        outcome: code === AMBIGUOUS_CODE ? "ambiguous" : "failure", http_status: metaError?.httpStatus ?? null,
        error_code: metaError?.code ?? code, error_message: technical.slice(0, 1000)
      });
      results.push({ id: post.id, result: "failed" });
    }
  }
  return results;
}
