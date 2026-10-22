"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { UserSyncStats } from "@/lib/feed-sync";

const REFRESH_EVERY_MS = 60 * 1000;

/**
 * Keeps the lists current without a click. On opening, if the Fanpages were not read in the last minute, asks the
 * server to read them now (the same call as the "Tải lại từ Facebook" button, silent here) and redraws if anything
 * was read. While the page stays open it redraws from the database once a minute, so what the scheduled reads
 * found (a post deleted on Facebook, a new post) shows up by itself.
 */
export default function FeedAutoRefresh({ stale }: { stale: boolean }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    if (stale) {
      fetch("/api/facebook/sync", { method: "POST" })
        .then((r) => (r.ok ? (r.json() as Promise<UserSyncStats>) : null))
        .then((stats) => { if (!cancelled && stats && stats.synced > 0) router.refresh(); })
        .catch(() => { /* silent: the scheduled read and the button still work */ });
    }
    const timer = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, REFRESH_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === "visible") router.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [stale, router]);

  return null;
}
