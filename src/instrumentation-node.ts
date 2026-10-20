// Built-in schedulers so scheduled posts are published (and lost Page access is detected)
// without an external cron. Runs in `next dev`; in production set INTERNAL_SCHEDULER=true on a
// long-running server (not needed on serverless: call /api/cron/publish and /api/cron/check-pages
// from an external scheduler with `Authorization: Bearer $CRON_SECRET`).
import { processDuePosts } from "@/lib/publisher";
import { checkAllConnections } from "@/lib/page-sync";

const PUBLISH_INTERVAL_MS = 30_000;
// checkAllConnections only touches connections not checked in ~20h, so a short interval is cheap and a
// restart never causes a full sweep.
const PAGE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PAGE_CHECK_FIRST_RUN_MS = 2 * 60 * 1000;

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
    const results = await processDuePosts();
    return results.length ? results : null;
  });
  every("page check", PAGE_CHECK_INTERVAL_MS, async () => {
    const r = await checkAllConnections();
    return r.checked ? r : null;
  }, PAGE_CHECK_FIRST_RUN_MS);

  console.log(`[scheduler] started: publish every ${PUBLISH_INTERVAL_MS / 1000}s, page check hourly (per-connection every ~20h)`);
}
