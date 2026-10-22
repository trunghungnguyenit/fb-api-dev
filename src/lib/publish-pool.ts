import { pickFair } from "@/lib/fair-queue";

// Scheduling half of the publisher: WHICH due post runs next, and how many at once. It knows nothing about
// Facebook or the database (the caller supplies `fetchBatch` and `publish`), so it can be tested with
// thousands of fake posts.
//
// Rules:
//  - up to `concurrency[lane]` posts in flight per lane (a slow lane, e.g. video, cannot starve text posts);
//  - never two posts of the same Fanpage at once (Facebook treats parallel posting to one Page as spam-like,
//    and it keeps one Page's rate limit from being burnt by its own burst);
//  - within a batch, users take turns (see pickFair), so one big backlog cannot starve the others;
//  - a Page that cannot publish right now (token dead, rate limited) is left alone for the rest of the run
//    instead of being claimed and bounced once per queued post.

/** Upper bound on posts held in memory waiting for their turn. */
const MAX_READY = 1000;

export type PoolPost ={ id: string; user_id: string; page_id: string };

export type PoolOutcome = {
  /**
   * requeued = went back to the queue untouched; lost = another worker claimed it first; processing = handed off to
   * Facebook (a video / Reel it is still converting), finished later by the follow-up job.
   */
  result: "published" | "failed" | "requeued" | "lost" | "processing";
  /** Leave this post's Page alone until then (epoch ms; Infinity = for the rest of this run). */
  blockPageUntil?: number;
};

export type PoolStopReason = "drained" | "budget" | "limit" | "paused" | "error";

export type PoolStats = {
  started: number;
  published: number;
  failed: number;
  requeued: number;
  lost: number;
  processing: number;
  /** Posts skipped (and left queued) because their Page was blocked during this run. */
  skippedBlocked: number;
  fetches: number;
  maxInFlight: number;
  durationMs: number;
  /** Average time of one publish call, in ms. */
  avgPublishMs: number;
  stopReason: PoolStopReason;
  /** True when the run stopped early (budget, limit, pause) with work possibly left. */
  hasMore: boolean;
};

export type PoolOptions<T extends PoolPost, C> = {
  /** Next batch of due posts, oldest first, after `cursor` (null = from the start). Empty posts = nothing left. */
  fetchBatch: (cursor: C | null) => Promise<{ posts: T[]; cursor: C | null }>;
  /** Publishes one post. Must report problems through its outcome rather than throw. */
  publish: (post: T) => Promise<PoolOutcome>;
  /** Maximum in flight per lane. A lane missing here gets 1. */
  concurrency: Record<string, number>;
  laneOf?: (post: T) => string;
  /** Stop starting new posts after this long (posts already started always finish). */
  budgetMs: number;
  /** Stop after starting this many posts. */
  limit?: number;
  /** Checked before each start: true stops the run (e.g. the whole app is rate limited). */
  shouldPause?: () => boolean;
  now?: () => number;
};

export async function runPublishPool<T extends PoolPost, C>(opts: PoolOptions<T, C>): Promise<PoolStats> {
  const now = opts.now ?? Date.now;
  const laneOf = opts.laneOf ?? (() => "default");
  const limit = opts.limit ?? Infinity;
  const startedAt = now();
  const totalSlots = Object.values(opts.concurrency).reduce((sum, n) => sum + Math.max(1, n), 0) || 1;

  const stats: PoolStats = {
    started: 0, published: 0, failed: 0, requeued: 0, lost: 0, processing: 0, skippedBlocked: 0, fetches: 0,
    maxInFlight: 0, durationMs: 0, avgPublishMs: 0, stopReason: "drained", hasMore: false
  };

  const ready: T[] = [];
  const running = new Set<Promise<void>>();
  const busyPages = new Set<string>();
  const blockedPages = new Map<string, number>();
  const inLane = new Map<string, number>();
  // Every post ever queued this run: a post is never handled twice in one run, and a batch that brings nothing new
  // ends the run's fetching (so a paging bug can never turn into a loop that re-reads the same rows until the budget ends).
  const seen = new Set<string>();
  let cursor: C | null = null;
  let exhausted = false;
  let publishMs = 0;
  let publishCount = 0;
  let firstFetchError: unknown;

  const isBlocked = (post: T) => (blockedPages.get(post.page_id) ?? 0) > now();

  /** The first ready post whose Page is idle and whose lane has room; posts of blocked Pages are dropped. */
  function pick(): T | undefined {
    for (let i = 0; i < ready.length; i++) {
      const post = ready[i];
      if (isBlocked(post)) { ready.splice(i--, 1); stats.skippedBlocked++; continue; }
      if (busyPages.has(post.page_id)) continue;
      const lane = laneOf(post);
      if ((inLane.get(lane) ?? 0) >= Math.max(1, opts.concurrency[lane] ?? 1)) continue;
      ready.splice(i, 1);
      return post;
    }
    return undefined;
  }

  function start(post: T) {
    const lane = laneOf(post);
    busyPages.add(post.page_id);
    inLane.set(lane, (inLane.get(lane) ?? 0) + 1);
    stats.started++;
    const t0 = now();
    const job: Promise<void> = opts.publish(post)
      .then((outcome) => {
        stats[outcome.result]++;
        if (outcome.blockPageUntil) blockedPages.set(post.page_id, outcome.blockPageUntil);
      })
      .catch((error) => {
        // publish() is meant not to throw; if it does, do not hammer the same Page with the rest of its posts.
        console.error(`publish pool: job for post ${post.id} threw:`, error);
        stats.failed++;
        blockedPages.set(post.page_id, Infinity);
      })
      .finally(() => {
        publishMs += now() - t0;
        publishCount++;
        busyPages.delete(post.page_id);
        inLane.set(lane, (inLane.get(lane) ?? 1) - 1);
        running.delete(job);
      });
    running.add(job);
    stats.maxInFlight = Math.max(stats.maxInFlight, running.size);
  }

  async function refill() {
    try {
      const batch = await opts.fetchBatch(cursor);
      stats.fetches++;
      cursor = batch.cursor;
      const fresh = batch.posts.filter((post) => !seen.has(post.id));
      if (!fresh.length) exhausted = true;
      else {
        for (const post of fresh) seen.add(post.id);
        ready.push(...pickFair(fresh, fresh.length));
      }
    } catch (error) {
      exhausted = true;
      if (stats.fetches === 0) firstFetchError = error;
      else { console.error("publish pool: fetching the next batch failed; finishing what is running:", error); stats.stopReason = "error"; }
    }
  }

  while (true) {
    if (stats.started >= limit) { stats.stopReason = "limit"; break; }
    if (now() - startedAt >= opts.budgetMs) { stats.stopReason = "budget"; break; }
    if (opts.shouldPause?.()) { stats.stopReason = "paused"; break; }

    let next: T | undefined;
    while (stats.started < limit && (next = pick())) start(next);

    // Fetch more when nothing is waiting, or when slots are idle because everything waiting belongs to a busy Page
    // (one Page with a large backlog must not leave the other slots empty while other Pages' posts sit deeper in the queue).
    if (!exhausted && ready.length < MAX_READY && (ready.length === 0 || running.size < totalSlots)) { await refill(); continue; }
    if (running.size === 0 && ready.length === 0) break; // nothing running, nothing left, nothing more to fetch
    if (running.size > 0) await Promise.race(running);
  }

  await Promise.allSettled([...running]);
  if (firstFetchError !== undefined) throw firstFetchError;

  stats.durationMs = now() - startedAt;
  stats.avgPublishMs = publishCount ? Math.round(publishMs / publishCount) : 0;
  stats.hasMore = stats.stopReason !== "drained" && stats.stopReason !== "error" && (ready.length > 0 || !exhausted);
  if (stats.stopReason !== "drained" && !stats.hasMore && stats.stopReason !== "error") stats.stopReason = "drained";
  return stats;
}
