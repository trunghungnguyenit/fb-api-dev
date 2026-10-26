import { one, userDb } from "@/lib/db";
import { type ErrorCode, messageFor } from "@/lib/errors";
import { FacebookActionError, isGoneError, runWithPageToken } from "@/lib/facebook-posts";
import { refusalOf, requireInsightsPage, stopsEverything } from "@/lib/insights";
import { MetaApiError, metaGet } from "@/lib/meta/client";
import { metricErrorKind } from "@/lib/meta/insights";
import {
  metricsFor, parsePostInsights, postValue, type PostMetricDef, type PostMetricKey, type PostValue, type PostVariant, type RawPostValue
} from "@/lib/meta/post-insights";

// Reads the Insights of ONE post from Facebook when its page is opened. Nothing is stored; what was read is kept in memory
// for a short while. Every metric is asked for on its own account, because Meta keeps retiring and renaming them: one that
// Facebook refuses is reported for that metric, the others still show.

export type PostInsightsTarget = { kind: "app" | "feed"; id: string };

export type PostMetricResult = {
  key: PostMetricKey; label: string; hint: string; unit: string; format?: "duration";
  state: "ok" | "problem";
  /** state "problem": which of our codes, and its Vietnamese text (Facebook's own wording is never passed on). */
  code?: ErrorCode; message?: string;
  /** state "ok": the number. */
  value?: PostValue;
};

/** `variant`: which numbers these are (a video or Reel has its own). */
export type PostInsightsResult = { variant: PostVariant; metrics: PostMetricResult[] };

// ---- Short memory ------------------------------------------------------------------------------------------------------
// Numbers change about once a day, so a repeated look does not need new calls. What Facebook REFUSED (or had nothing for)
// is remembered only briefly, and per post: whether a metric exists can depend on the post, and a new post may get its numbers
// within minutes, so "Thử lại" must be able to find out.
const VALUE_MS = 30 * 60_000;
const PROBLEM_MS = 5 * 60_000;
const CACHE_MAX = 400;
type ReadEntry = { value: RawPostValue } | { problem: ErrorCode };
const cache = new Map<string, { at: number; entry: ReadEntry }>();
export function clearPostInsightsCache() { cache.clear(); }
const keyOf = (userId: string, postFbId: string, graph: string) => `${userId}|${postFbId}|${graph}`;
function remember(key: string, entry: ReadEntry) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), entry });
}
const fresh = (hit: { at: number; entry: ReadEntry }) => Date.now() - hit.at < ("problem" in hit.entry ? PROBLEM_MS : VALUE_MS);

export type Resolved = { pageRowId: string; facebookPostId: string; variant: PostVariant };

/**
 * Which Facebook post this is, once it is known to be live, and what kind it is. Other readers of one post (the reactions)
 * word the "not live" failure themselves.
 */
export async function resolveTarget(
  userId: string, target: PostInsightsTarget, opts: { unavailable: ErrorCode } = { unavailable: "INSIGHTS_POST_UNAVAILABLE" }
): Promise<Resolved> {
  const db = userDb(userId);
  if (target.kind === "app") {
    const { data, error } = await db.posts.select("page_id,status,post_type,facebook_post_id,facebook_deleted_at").eq("id", target.id).maybeSingle();
    if (error) throw new FacebookActionError("DB_ERROR", false, error);
    const post = one<{ page_id: string; status: string; post_type: string | null; facebook_post_id: string | null; facebook_deleted_at: string | null }>(data);
    if (!post) throw new FacebookActionError("POST_NOT_FOUND");
    if (post.status !== "published" || post.facebook_deleted_at || !post.facebook_post_id) throw new FacebookActionError(opts.unavailable);
    return { pageRowId: post.page_id, facebookPostId: post.facebook_post_id, variant: post.post_type === "reel" ? "reel" : post.post_type === "video" ? "video" : "post" };
  }
  const { data, error } = await db.feed.select("page_id,facebook_post_id,status_type,missing_since").eq("id", target.id).maybeSingle();
  if (error) throw new FacebookActionError("DB_ERROR", false, error);
  const post = one<{ page_id: string; facebook_post_id: string; status_type: string | null; missing_since: string | null }>(data);
  if (!post) throw new FacebookActionError("POST_NOT_FOUND");
  if (post.missing_since) throw new FacebookActionError(opts.unavailable);
  // The feed does not say a Reel from a video: it is read as a video.
  return { pageRowId: post.page_id, facebookPostId: post.facebook_post_id, variant: post.status_type === "added_video" ? "video" : "post" };
}

/**
 * The post itself is gone on Facebook (deleted or hidden, and our copy has not caught up yet): Facebook answers a missing post
 * like a missing permission, but here it is the post, so the user must not be told to reconnect.
 */
function postGone(e: unknown, variant: PostVariant): FacebookActionError | null {
  // For a video the answer "unsupported get request" (100 / 33) more likely says the video node does not offer this metric
  // than that the video is gone: it is told per metric instead (see nodeLacksMetric).
  if (variant !== "post" && nodeLacksMetric(e)) return null;
  return isGoneError(e) ? new FacebookActionError("INSIGHTS_POST_UNAVAILABLE", true, e) : null;
}

const nodeLacksMetric = (e: unknown) => e instanceof MetaApiError && e.code === "100" && e.subcode === "33";

// A video made here is known by its VIDEO id, but its numbers are those of the post that shows it. Ask Facebook which post that
// is (once, and remember): if it will not say, the video id is used as it is, and the metrics report what Facebook makes of it.
const POST_ID = /^\d{1,30}_\d{1,30}$/;
const postIdOf = new Map<string, { at: number; id: string | null }>();
const LOOKUP_OK_MS = 6 * 3_600_000;
const LOOKUP_FAILED_MS = 5 * 60_000;
export function clearVideoLookupCache() { postIdOf.clear(); }

async function insightsIdOf(userId: string, token: string, facebookPostId: string): Promise<string> {
  if (POST_ID.test(facebookPostId)) return facebookPostId; // already a post id
  const key = `${userId}|${facebookPostId}`;
  const hit = postIdOf.get(key);
  if (hit && Date.now() - hit.at < (hit.id ? LOOKUP_OK_MS : LOOKUP_FAILED_MS)) return hit.id ?? facebookPostId;
  let id: string | null = null;
  try {
    const res = await metaGet<{ post_id?: unknown }>(facebookPostId, token, { fields: "post_id" });
    id = typeof res.post_id === "string" && POST_ID.test(res.post_id) ? res.post_id : null;
  } catch (e) {
    if (stopsEverything(e)) throw e;
  }
  if (postIdOf.size >= CACHE_MAX) postIdOf.delete(postIdOf.keys().next().value as string);
  postIdOf.set(key, { at: Date.now(), id });
  return id ?? facebookPostId;
}

const ask = async (token: string, postFbId: string, graph: string[]) =>
  parsePostInsights(await metaGet(`${postFbId}/insights`, token, { metric: graph.join(","), period: "lifetime" }));

/** Values for one post: one request for all metrics, and metric by metric if Facebook refuses that. */
async function readPost(userId: string, token: string, postFbId: string, defs: readonly PostMetricDef[], variant: PostVariant): Promise<Map<PostMetricKey, ReadEntry>> {
  const out = new Map<PostMetricKey, ReadEntry>();
  const missing: PostMetricDef[] = [];
  for (const def of defs) {
    const hit = cache.get(keyOf(userId, postFbId, def.graph));
    if (hit && fresh(hit)) out.set(def.key, hit.entry);
    else missing.push(def);
  }
  if (!missing.length) return out;

  const set = (def: PostMetricDef, entry: ReadEntry) => {
    remember(keyOf(userId, postFbId, def.graph), entry);
    out.set(def.key, entry);
  };
  const store = (def: PostMetricDef, parsed: Map<string, RawPostValue | null>) => {
    const value = parsed.get(def.graph);
    set(def, value === null || value === undefined ? { problem: "INSIGHTS_POST_NO_DATA" } : { value });
  };

  try {
    const parsed = await ask(token, postFbId, missing.map((d) => d.graph));
    for (const def of missing) store(def, parsed);
    return out;
  } catch (e) {
    const gone = postGone(e, variant);
    if (gone) throw gone;
    if (stopsEverything(e)) throw e;
    if (metricErrorKind(e as MetaApiError) === "permission" && !(variant !== "post" && nodeLacksMetric(e))) throw new FacebookActionError("INSIGHTS_PERMISSION_DENIED", false, e);
    console.warn(`post insights: the combined request was refused (${(e as MetaApiError).code}); asking metric by metric`, (e as MetaApiError).message);
  }
  for (const def of missing) {
    try { store(def, await ask(token, postFbId, [def.graph])); }
    catch (e) {
      const gone = postGone(e, variant);
      if (gone) throw gone;
      // The combined request got through to this point, so a "permission" answer for ONE metric is about that metric (a metric
      // the post's kind does not have), not about the Page: it must not hide the numbers that did arrive.
      if (e instanceof MetaApiError && !stopsEverything(e) && metricErrorKind(e) === "permission") {
        set(def, { problem: nodeLacksMetric(e) ? "INSIGHTS_METRIC_UNSUPPORTED" : "INSIGHTS_METRIC_FAILED" });
        continue;
      }
      // Not remembered for everybody: whether a post has a metric is not a fact about Facebook as a whole.
      set(def, { problem: refusalOf(e, def.graph, { remember: false }) });
    }
  }
  return out;
}

/**
 * Insights of one of the user's posts, from Facebook. Throws FacebookActionError with a code that says exactly what is
 * wrong: unknown post, post not live (or deleted meanwhile), Fanpage removed or off, `read_insights` not granted,
 * no "Analyze" task, Facebook refusing the Page, rate limit, outage.
 */
export async function loadPostInsights(userId: string, target: PostInsightsTarget): Promise<PostInsightsResult> {
  const { pageRowId, facebookPostId, variant } = await resolveTarget(userId, target);
  const defs = metricsFor(variant);
  const page = await requireInsightsPage(userId, pageRowId);
  return runWithPageToken(userId, page.id, "read", `insights of post ${target.kind}:${target.id}`, async (token) => {
    const askedId = variant === "post" ? facebookPostId : await insightsIdOf(userId, token, facebookPostId);
    const read = await readPost(userId, token, askedId, defs, variant);
    return {
      variant,
      metrics: defs.map((def): PostMetricResult => {
        const base = { key: def.key, label: def.label, hint: def.hint, unit: def.unit, ...(def.format ? { format: def.format } : {}) };
        const problem = (code: ErrorCode): PostMetricResult => ({ ...base, state: "problem", code, message: messageFor(code) });
        const entry = read.get(def.key);
        if (!entry) return problem("INSIGHTS_POST_NO_DATA");
        if ("problem" in entry) return problem(entry.problem);
        const value = postValue(entry.value);
        return value ? { ...base, state: "ok", value } : problem("INSIGHTS_POST_NO_DATA");
      })
    };
  });
}
