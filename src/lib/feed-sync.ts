import { decryptSecret } from "@/lib/crypto";
import { one, rows, userDb } from "@/lib/db";
import { MetaApiError, metaGet } from "@/lib/meta/client";
import {
  commentIncreases, FEED_FIELDS_BASIC, FEED_FIELDS_FULL, mapFeedPost, nextSyncAfter, planAbsences, seenNeedsUpdate, SYNC_INTERVAL_MS, windowStart,
  type GraphFeedPost, type KnownFeedRow, type MappedFeedPost
} from "@/lib/meta/feed-posts";
import { describeMetaError, isPermissionError } from "@/lib/meta/pages";
import { isRateLimitCode, LOCAL_RATE_LIMIT_CODE } from "@/lib/meta/usage";
import { clearFacebookGone, markFacebookGone } from "@/lib/facebook-posts";
import { recordNewComments } from "@/lib/new-comments";
import { readRatingCount, recordRatingCount } from "@/lib/new-ratings";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";
import { deactivatePage } from "@/lib/page-sync";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Keeps a read-only copy of what is on each Fanpage (posts published OUTSIDE this app too), for the last 7 days,
// refreshed about every 15 minutes per Page. Nothing here writes to Facebook, and nothing else in the app writes
// to page_feed_posts: those rows can only be looked at.

const PAGE_SIZE = 100;
const REDUCED_PAGE_SIZE = 25;
/** 10 x 100 posts: far more than a Page publishes in a week. Beyond it the read is "incomplete" and judges nothing. */
const MAX_BATCHES = 10;
const WRITE_CHUNK = 100;
const LOOKUP_CHUNK = 80;
/** A failed attempt is retried sooner than the normal interval if the cause is probably brief, later if it is a permission problem. */
const RETRY_SOON_MS = 5 * 60 * 1000;
const RETRY_LATER_MS = 60 * 60 * 1000;
const MANUAL_MIN_GAP_MS = 60 * 1000;
const DEFAULT_BUDGET_MS = 45_000;

export type FeedPage = { id: string; user_id: string; page_id: string; page_access_token_encrypted: string; feed_synced_at?: string | null };

const chunk = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

/** Reads every post of the window, following cursors. `complete` = the whole window was read (nothing was cut off). */
export async function fetchFeedWindow(token: string, facebookPageId: string, since: Date) {
  let fields = FEED_FIELDS_FULL;
  let limit = PAGE_SIZE;
  let degraded = false;
  let reduced = false;
  let after: string | undefined;
  const posts: MappedFeedPost[] = [];

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    let result: { data?: GraphFeedPost[]; paging?: { cursors?: { after?: string }; next?: string } };
    try {
      result = await metaGet(`${facebookPageId}/posts`, token, {
        fields, limit: String(limit), since: String(Math.floor(since.getTime() / 1000)), ...(after ? { after } : {})
      });
    } catch (e) {
      // "Please reduce the amount of data" (1): ask for fewer posts at a time. A refused field (100): fall back to the
      // plain post. Each fallback is tried once, then the error stands.
      if (e instanceof MetaApiError && e.code === "1" && !reduced) { reduced = true; limit = REDUCED_PAGE_SIZE; batch--; continue; }
      if (e instanceof MetaApiError && e.code === "100" && !degraded) { degraded = true; fields = FEED_FIELDS_BASIC; batch--; continue; }
      throw e;
    }
    for (const g of result.data ?? []) {
      const mapped = mapFeedPost(g, { engagement: fields === FEED_FIELDS_FULL });
      if (mapped) posts.push(mapped);
    }
    // `paging.next` carries the access token, so only the cursor is used.
    if (!result.paging?.next) return { posts, complete: true, degraded };
    after = result.paging.cursors?.after;
    if (!after) return { posts, complete: false, degraded };
  }
  return { posts, complete: false, degraded };
}

/** `missing`: posts confirmed gone by this read; `pending`: posts missed once, waiting for a second read to be believed. */
export type StoreResult = { seen: number; created: number; missing: number; pending: number };

/** Writes what was read: new posts, refreshed numbers, links to this app's own posts, and posts that vanished. */
export async function storeFeed(
  page: Pick<FeedPage, "id" | "user_id">, mapped: MappedFeedPost[], complete: boolean, now: Date
): Promise<StoreResult> {
  const db = userDb(page.user_id);
  const since = windowStart(now);
  const nowIso = now.toISOString();
  const unique = [...new Map(mapped.map((p) => [p.facebook_post_id, p])).values()];

  // What is already stored for this window.
  const { data: knownData, error: knownError } = await db.feed
    .select("id,facebook_post_id,created_time,absent_checks,missing_since,comments_count,comments_seen_count").eq("page_id", page.id).gte("created_time", since.toISOString());
  if (knownError) throw knownError;
  const known = rows<KnownFeedRow>(knownData);
  const knownIds = new Set(known.map((k) => k.facebook_post_id));

  // Posts this app published itself are recognised by their Facebook id (or the id of an attached photo / video).
  const keys = [...new Set(unique.flatMap((p) => p.link_keys))];
  const ownPosts = new Map<string, string>();
  for (const part of chunk(keys, LOOKUP_CHUNK)) {
    const { data, error } = await db.posts.select("id,facebook_post_id").in("facebook_post_id", part);
    if (error) throw error;
    for (const p of rows<{ id: string; facebook_post_id: string }>(data)) ownPosts.set(p.facebook_post_id, p.id);
  }
  const ownPostOf = (p: MappedFeedPost) => p.link_keys.map((k) => ownPosts.get(k)).find(Boolean) ?? null;

  const row = (p: MappedFeedPost) => ({
    page_id: page.id, facebook_post_id: p.facebook_post_id, message: p.message, permalink_url: p.permalink_url, status_type: p.status_type,
    created_time: p.created_time, media: p.media, reactions_count: p.reactions_count, comments_count: p.comments_count, shares_count: p.shares_count,
    last_seen_at: nowIso, absent_checks: 0, missing_since: null, post_id: ownPostOf(p), updated_at: nowIso
  });
  const fresh = unique.filter((p) => !knownIds.has(p.facebook_post_id));
  const existing = unique.filter((p) => knownIds.has(p.facebook_post_id));
  // Which posts gained comments since the last read: worked out from the stored counts BEFORE they are overwritten.
  const increases = commentIncreases(known, unique);
  const knownBy = new Map(known.map((k) => [k.facebook_post_id, k]));
  const needsSeen = (p: MappedFeedPost) => seenNeedsUpdate(knownBy.get(p.facebook_post_id)!, p.comments_count);
  // A read without the count (the plain-fields fallback) must not erase the stored one: it is the baseline of the next comparison.
  const lacksCount = (p: MappedFeedPost) => p.comments_count === null && typeof knownBy.get(p.facebook_post_id)?.comments_count === "number";
  const withoutCount = (p: MappedFeedPost) => Object.fromEntries(Object.entries(row(p)).filter(([key]) => key !== "comments_count"));
  // Homogeneous batches (a missing column would be written as null): first_seen_at is only written for posts seen for the
  // first time, the "seen" mark only when it has to be set (a first mark, or the count fell below it), and the count only
  // when this read has one.
  const batches: Record<string, unknown>[][] = [
    ...chunk(fresh, WRITE_CHUNK).map((part) => part.map((p) => ({ ...row(p), first_seen_at: nowIso, comments_seen_count: p.comments_count }))),
    ...chunk(existing.filter(needsSeen), WRITE_CHUNK).map((part) => part.map((p) => ({ ...row(p), comments_seen_count: p.comments_count }))),
    ...chunk(existing.filter(lacksCount), WRITE_CHUNK).map((part) => part.map(withoutCount)),
    ...chunk(existing.filter((p) => !needsSeen(p) && !lacksCount(p)), WRITE_CHUNK).map((part) => part.map(row))
  ];
  for (const batch of batches) {
    const { error } = await db.feed.upsert(batch, { onConflict: "user_id,page_id,facebook_post_id" });
    if (error) throw error;
  }
  // After the new counts are stored, so a retried read can never announce the same comments twice. The price is that a
  // failure half-way through the batches above loses the announcements of the batches already stored (the retry sees no rise).
  const readById = new Map(unique.map((p) => [p.facebook_post_id, p]));
  await recordNewComments(page.user_id, page.id, increases.map((inc) => {
    const post = readById.get(inc.facebookPostId);
    return { ...inc, appPostId: post ? ownPostOf(post) : null };
  }), now);

  let missing = 0;
  let pending = 0;
  if (complete) {
    const { firstMiss, confirmed } = planAbsences(known, new Set(unique.map((p) => p.facebook_post_id)), since);
    for (const part of chunk(firstMiss, WRITE_CHUNK)) {
      const { error } = await db.feed.update({ absent_checks: 1, updated_at: nowIso }).in("id", part);
      if (error) throw error;
    }
    for (const part of chunk(confirmed, WRITE_CHUNK)) {
      const { error } = await db.feed.update({ absent_checks: 2, missing_since: nowIso, updated_at: nowIso }).in("id", part);
      if (error) throw error;
    }
    missing = confirmed.length;
    pending = firstMiss.length;
  }
  return { seen: unique.length, created: fresh.length, missing, pending };
}

/**
 * Carries what the read learned about the posts THIS APP published over to the posts table: a post confirmed missing on
 * the Fanpage is marked "deleted on Facebook" (and the user is told), a marked post that was seen live again in this
 * read is restored. Only rows seen (or confirmed missing) by this very read count: a post at the window's edge, or one
 * the app itself just deleted and Facebook still lists for a moment, must not flip back.
 */
export async function reconcileOwnPosts(page: Pick<FeedPage, "id" | "user_id">, now: Date) {
  const db = userDb(page.user_id);
  const { data, error } = await db.feed
    .select("post_id,missing_since,last_seen_at").eq("page_id", page.id).not("post_id", "is", null).gte("created_time", windowStart(now).toISOString());
  if (error) throw error;
  const links = new Map<string, { missingSince: string | null; seenNow: boolean }>();
  for (const l of rows<{ post_id: string; missing_since: string | null; last_seen_at: string }>(data)) {
    links.set(l.post_id, { missingSince: l.missing_since, seenNow: new Date(l.last_seen_at).getTime() >= now.getTime() });
  }
  const stats = { flagged: 0, restored: 0 };
  for (const part of chunk([...links.keys()], LOOKUP_CHUNK)) {
    const { data: postData, error: postError } = await db.posts.select("id,facebook_deleted_at").in("id", part);
    if (postError) throw postError;
    for (const post of rows<{ id: string; facebook_deleted_at: string | null }>(postData)) {
      const link = links.get(post.id)!;
      if (link.missingSince && !post.facebook_deleted_at) {
        await markFacebookGone(page.user_id, post.id, "detected_missing");
        await notify(page.user_id, { type: "POST_DELETED_ON_FACEBOOK", dedupeKey: dedupeKeys.postDeleted(post.id, link.missingSince), pageId: page.id, postId: post.id });
        stats.flagged++;
      } else if (!link.missingSince && link.seenNow && post.facebook_deleted_at) {
        await clearFacebookGone(page.user_id, post.id);
        stats.restored++;
      }
    }
  }
  return stats;
}

export type SyncResult =
  | ({ status: "synced"; degraded: boolean; complete: boolean } & StoreResult)
  | { status: "deferred"; until: Date }
  | { status: "failed"; error: string };

/** Syncs one Page and records when it is due next. Never throws: a Page's trouble is recorded on the Page. */
export async function syncPageFeed(page: FeedPage, now: Date = new Date(), opts: { ratings?: boolean } = {}): Promise<SyncResult> {
  const db = userDb(page.user_id);
  const stamp = async (patch: Record<string, unknown>) => {
    const { error } = await db.pages.update(patch).eq("id", page.id);
    if (error) console.error(`recording the feed sync state of page ${page.id} failed:`, error);
  };
  const failed = async (error: string, retryInMs: number): Promise<SyncResult> => {
    await stamp({ feed_sync_error: error, feed_next_sync_at: new Date(now.getTime() + retryInMs).toISOString() });
    return { status: "failed", error };
  };

  let token: string;
  try { token = decryptSecret(page.page_access_token_encrypted); }
  catch (e) { console.error(`feed sync: cannot decrypt the token of page ${page.id}:`, e); return failed("TOKEN_DECRYPT_FAILED", RETRY_LATER_MS); }

  try {
    const { posts, complete, degraded } = await fetchFeedWindow(token, page.page_id, windowStart(now));
    const stored = await storeFeed(page, posts, complete, now);
    await stamp({ feed_synced_at: now.toISOString(), feed_next_sync_at: nextSyncAfter(now).toISOString(), feed_sync_error: null });
    // The read itself succeeded; failing to carry it over to the app's posts is retried by the next read.
    await reconcileOwnPosts(page, now).catch((e) => console.error(`feed sync: updating the app's posts of page ${page.id} failed:`, e));
    // Last, so a slow answer delays nothing above: how many ratings the Page has now, to tell when new ones arrive (best effort, never throws).
    if (opts.ratings !== false) {
      const ratings = await readRatingCount(token, page.page_id);
      if (ratings !== null) await recordRatingCount(page.user_id, page.id, ratings, now);
    }
    return { status: "synced", degraded, complete, ...stored };
  } catch (e) {
    if (e instanceof MetaApiError && (isRateLimitCode(e.code) || e.code === LOCAL_RATE_LIMIT_CODE)) {
      // Facebook (or our own back-off) says wait: try again when calls may resume, nothing is recorded as an error.
      const until = new Date(e.retryAt ?? now.getTime() + RETRY_SOON_MS);
      await stamp({ feed_next_sync_at: until.toISOString() });
      return { status: "deferred", until };
    }
    if (isPermissionError(e)) {
      await deactivatePage(page.user_id, page.id); // the Page token is dead; the user is told once
      return failed("PAGE_PERMISSION_LOST", RETRY_LATER_MS);
    }
    if (e instanceof MetaApiError) {
      const code = describeMetaError(e);
      console.warn(`feed sync of page ${page.id} failed (${code}):`, e.message, { code: e.code, subcode: e.subcode, trace: e.traceId });
      return failed(code, code === "FB_PERMISSION_DENIED" ? RETRY_LATER_MS : SYNC_INTERVAL_MS);
    }
    console.error(`feed sync of page ${page.id} failed:`, e);
    return failed("FB_UNAVAILABLE", RETRY_SOON_MS);
  }
}

export type DueStats = { due: number; synced: number; deferred: number; failed: number; skipped: number; stoppedEarly: boolean };

/**
 * System job: syncs the Pages whose turn has come, oldest first, a few at a time, within a time budget. A Page is
 * claimed (pushed 5 minutes ahead) before it is read, so two runs never read the same Page, and a crash only delays it.
 */
export async function syncDueFeeds(opts: { budgetMs?: number; concurrency?: number; limit?: number; now?: Date } = {}): Promise<DueStats> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const dueFilter = `feed_next_sync_at.is.null,feed_next_sync_at.lte.${now.toISOString()}`;
  const stats: DueStats = { due: 0, synced: 0, deferred: 0, failed: 0, skipped: 0, stoppedEarly: false };

  const { data, error } = await supabaseAdmin.from("facebook_pages")
    .select("id,user_id,page_id,page_access_token_encrypted")
    .eq("is_active", true).is("removed_at", null).or(dueFilter)
    .order("feed_next_sync_at", { ascending: true, nullsFirst: true }).limit(opts.limit ?? 300);
  if (error) throw error;
  const queue = [...(data ?? [])] as unknown as FeedPage[];
  stats.due = queue.length;

  async function worker() {
    for (let page = queue.shift(); page; page = queue.shift()) {
      if (Date.now() - started > (opts.budgetMs ?? DEFAULT_BUDGET_MS)) { stats.stoppedEarly = true; return; }
      const { data: claimed, error: claimError } = await supabaseAdmin.from("facebook_pages")
        .update({ feed_next_sync_at: new Date(now.getTime() + RETRY_SOON_MS).toISOString() })
        .eq("id", page.id).or(dueFilter).select("id");
      if (claimError || !claimed?.length) { stats.skipped++; continue; }
      const result = await syncPageFeed(page, now);
      stats[result.status === "synced" ? "synced" : result.status === "deferred" ? "deferred" : "failed"]++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, Math.max(queue.length, 1)) }, worker));
  return stats;
}

/** Pause between the two reads that confirm a deleted post when the user asks for a reload. */
const CONFIRM_DELAY_MS = 2000;

/**
 * "Sync now" for one Page of this user, at most once a minute. A post is only believed gone after two complete reads,
 * so when the first read misses a post this one reads again right away: one click is enough to see a deletion
 * (waiting for the next scheduled read would take 15 minutes).
 */
export async function syncPageNow(userId: string, pageRowId: string, now: Date = new Date(), opts: { confirmDelayMs?: number } = {}) {
  const { data, error } = await userDb(userId).pages
    .select("id,user_id,page_id,page_access_token_encrypted,feed_synced_at,is_active,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw error;
  const page = one<FeedPage & { is_active: boolean; removed_at: string | null }>(data);
  if (!page || page.removed_at) return { status: "not_found" as const };
  if (!page.is_active) return { status: "inactive" as const };
  if (page.feed_synced_at && now.getTime() - new Date(page.feed_synced_at).getTime() < MANUAL_MIN_GAP_MS) return { status: "too_soon" as const };
  const first = await syncPageFeed(page, now);
  if (first.status !== "synced" || !first.complete || first.pending === 0) return first;
  const delay = opts.confirmDelayMs ?? CONFIRM_DELAY_MS;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const second = await syncPageFeed(page, new Date(now.getTime() + delay), { ratings: false }); // the ratings were just counted
  return second.status === "synced" ? { ...second, created: first.created + second.created } : first;
}

export type UserSyncStats = { pages: number; synced: number; seen: number; created: number; removed: number; recent: number; deferred: number; failed: number; lastError: string | null };

/** "Reload" on the Facebook tab: syncs every active Page of this user now (a Page read less than a minute ago counts as up to date). */
export async function syncUserFeedsNow(userId: string, now: Date = new Date()): Promise<UserSyncStats> {
  const { data, error } = await userDb(userId).pages.select("id").eq("is_active", true).is("removed_at", null);
  if (error) throw error;
  const queue = rows<{ id: string }>(data).map((p) => p.id);
  const stats: UserSyncStats = { pages: queue.length, synced: 0, seen: 0, created: 0, removed: 0, recent: 0, deferred: 0, failed: 0, lastError: null };

  async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const result = await syncPageNow(userId, id, now);
      if (result.status === "synced") { stats.synced++; stats.seen += result.seen; stats.created += result.created; stats.removed += result.missing; }
      else if (result.status === "too_soon") stats.recent++;
      else if (result.status === "deferred") stats.deferred++;
      else if (result.status === "failed") { stats.failed++; stats.lastError = result.error; }
      else stats.pages--; // removed or turned off while this ran
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, Math.max(queue.length, 1)) }, worker));
  return stats;
}
