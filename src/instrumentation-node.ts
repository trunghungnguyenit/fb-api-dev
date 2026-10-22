// Built-in schedulers so scheduled posts are published (and lost Page access is detected, Pages' own posts are
// read, unused media is cleaned up) without an external cron. Runs in `next dev`; in production set
// INTERNAL_SCHEDULER=true on a long-running server (not needed on serverless: call /api/cron/publish,
// /api/cron/sync-posts, /api/cron/check-pages and /api/cron/cleanup-media from an external scheduler with
// `Authorization: Bearer $CRON_SECRET`).
import { runPublishCycle } from "@/lib/publisher";
import { checkAllConnections } from "@/lib/page-sync";
import { cleanupMedia } from "@/lib/media/cleanup";
import { syncDueFeeds } from "@/lib/feed-sync";
import { verifyOlderPosts } from "@/lib/post-liveness";

const PUBLISH_INTERVAL_MS = 30_000;
// checkAllConnections only touches connections not checked in ~20h, so a short interval is cheap and a
// restart never causes a full sweep.
// A run that stopped only because its time budget ended, with posts still due, is followed by another one right
// away (a burst of thousands of posts would otherwise wait for the next tick between runs). The cap keeps a
// permanent backlog from starving the other job.
const MAX_BACK_TO_BACK_RUNS = 20;
const PAGE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PAGE_CHECK_FIRST_RUN_MS = 2 * 60 * 1000;
// Each Fanpage's posts are read from Facebook every FEED_SYNC_INTERVAL_MIN minutes (default 5); this tick only picks the
// Pages that are due, and asks Facebook directly about a few app posts older than the 7-day window.
const FEED_SYNC_INTERVAL_MS = 60 * 1000;
const FEED_SYNC_FIRST_RUN_MS = 20 * 1000;
const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MEDIA_CLEANUP_FIRST_RUN_MS = 5 * 60 * 1000;

/** Runs `job` every `everyMs`, skipping a tick while the previous run is still going. */
function every(name: string, everyMs: number, job: () => Promise<unknown>, firstRunMs = everyMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await job();
      if (result) console.log(`[scheduler] ${name}`, result);
    } catch (e) {
      console.error(`[scheduler] ${name} error:`, e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, firstRunMs).unref();
  setInterval(tick, everyMs).unref();
}

export function startScheduler() {
  if (process.env.NODE_ENV === "production" && process.env.INTERNAL_SCHEDULER !== "true") return;

  const g = globalThis as { __publishScheduler?: boolean };
  if (g.__publishScheduler) return;
  g.__publishScheduler = true;

  every("publish", PUBLISH_INTERVAL_MS, async () => {
    const total = { published: 0, failed: 0, requeued: 0, runs: 0 };
    for (let i = 0; i < MAX_BACK_TO_BACK_RUNS; i++) {
      const { stats } = await runPublishCycle();
      total.published += stats.published; total.failed += stats.failed; total.requeued += stats.requeued; total.runs++;
      if (!stats.hasMore || stats.stopReason !== "budget") break;
    }
    return total.published || total.failed || total.requeued ? total : null;
  });
  every("page check", PAGE_CHECK_INTERVAL_MS, async () => {
    const r = await checkAllConnections();
    return r.checked ? r : null;
  }, PAGE_CHECK_FIRST_RUN_MS);
  every("feed sync", FEED_SYNC_INTERVAL_MS, async () => {
    const feeds = await syncDueFeeds();
    const older = await verifyOlderPosts();
    return feeds.due || older.checked ? { ...feeds, older } : null;
  }, FEED_SYNC_FIRST_RUN_MS);
  every("media cleanup", MEDIA_CLEANUP_INTERVAL_MS, async () => {
    const r = await cleanupMedia();
    return r.unattachedRows || r.purgedFiles || r.errors ? r : null;
  }, MEDIA_CLEANUP_FIRST_RUN_MS);

  console.log(`[scheduler] started: publish every ${PUBLISH_INTERVAL_MS / 1000}s, page check hourly (per-connection every ~20h), Pages' posts read every minute (per Page every ${process.env.FEED_SYNC_INTERVAL_MIN || 5} min), media cleanup hourly`);
}
