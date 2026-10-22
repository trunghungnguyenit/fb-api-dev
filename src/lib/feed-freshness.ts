import { rows, userDb } from "@/lib/db";

/** Data read from Facebook less than this long ago is fresh enough: opening a page does not read again (the server allows one read a minute per Fanpage anyway). */
export const FEED_STALE_AFTER_MS = 60 * 1000;

type PageSyncState = { is_active: boolean; removed_at: string | null; feed_synced_at: string | null };

/** True when some active Fanpage was never read, or not within the last minute. */
export function feedIsStale(pages: PageSyncState[], now: number = Date.now()) {
  return pages.some((p) => p.is_active && !p.removed_at && (!p.feed_synced_at || now - new Date(p.feed_synced_at).getTime() > FEED_STALE_AFTER_MS));
}

export async function feedIsStaleForUser(userId: string) {
  const { data, error } = await userDb(userId).pages.select("is_active,removed_at,feed_synced_at");
  if (error) { console.error("feed freshness check failed:", error); return false; }
  return feedIsStale(rows<PageSyncState>(data));
}
