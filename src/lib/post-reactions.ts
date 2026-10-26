import { FacebookActionError, isGoneError, runWithPageToken } from "@/lib/facebook-posts";
import { MetaApiError, metaGet } from "@/lib/meta/client";
import { describeMetaError } from "@/lib/meta/pages";
import { parseReactions, REACTION_TYPES, reactionFields, type ReactionsView } from "@/lib/meta/post-reactions";
import { resolveTarget, type PostInsightsTarget } from "@/lib/post-insights";

// Reactions of one post by kind, read from Facebook when its page is opened. Nothing is stored.

export type PostReactionsResult = ReactionsView;

// A refused combined request costs nine calls (combined, total, seven kinds); the same post is not asked again for a while.
const DEGRADED_MS = 5 * 60_000;
const degraded = new Map<string, { at: number; view: PostReactionsResult }>();
export function clearPostReactionsCache() { degraded.clear(); }

const ask = (token: string, postFbId: string, types: readonly { key: string; graph: string }[], withTotal = true) =>
  metaGet(postFbId, token, { fields: reactionFields(types, withTotal) });

/**
 * Reactions of one of the user's posts: one request for every kind, and kind by kind if Facebook refuses that (the names of
 * the kinds are the part of this API Meta has changed before). A kind Facebook will not answer stays empty; the others show.
 * Throws FacebookActionError with a code that says what is wrong: unknown post, post not live (or deleted meanwhile),
 * Fanpage removed or off, permission refused, rate limit, outage.
 */
export async function loadPostReactions(userId: string, target: PostInsightsTarget): Promise<PostReactionsResult> {
  const { pageRowId, facebookPostId } = await resolveTarget(userId, target, { unavailable: "REACTIONS_POST_UNAVAILABLE" });
  const cacheKey = `${userId}|${facebookPostId}`;
  const hit = degraded.get(cacheKey);
  if (hit && Date.now() - hit.at < DEGRADED_MS) return hit.view;
  return runWithPageToken(userId, pageRowId, "read", `reactions of post ${target.kind}:${target.id}`, async (token) => {
    // Facebook answers a missing post like a missing permission; a post gone meanwhile must not tell the user to reconnect.
    const translate = (e: unknown): never => {
      if (isGoneError(e)) throw new FacebookActionError("REACTIONS_POST_UNAVAILABLE", true, e);
      if (e instanceof MetaApiError && describeMetaError(e) === "FB_PERMISSION_DENIED") throw new FacebookActionError("REACTIONS_PERMISSION_DENIED", false, e);
      throw e;
    };
    try {
      return parseReactions(await ask(token, facebookPostId, REACTION_TYPES));
    } catch (e) {
      if (!(e instanceof MetaApiError && e.code === "100" && !isGoneError(e))) translate(e);
      console.warn(`post reactions: the combined request was refused (${(e as MetaApiError).code}); asking kind by kind`, (e as MetaApiError).message);
    }
    const parts = new Map<string, number | null>();
    const one = async (types: typeof REACTION_TYPES, withTotal: boolean) => {
      try { return parseReactions(await ask(token, facebookPostId, types, withTotal)); }
      catch (e) {
        if (e instanceof MetaApiError && e.code === "100" && !isGoneError(e)) return null;
        return translate(e);
      }
    };
    const total = (await one([], true))?.total ?? null;
    for (const type of REACTION_TYPES) {
      const answer = await one([type], false);
      parts.set(type.key, answer?.types.find((t) => t.key === type.key)?.value ?? null);
    }
    const view = { total, types: REACTION_TYPES.map((t) => ({ key: t.key, label: t.label, value: parts.get(t.key) ?? null })) };
    if (degraded.size >= 200) degraded.delete(degraded.keys().next().value as string);
    degraded.set(cacheKey, { at: Date.now(), view });
    return view;
  });
}
