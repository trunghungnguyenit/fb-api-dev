import { one, rows, userDb } from "@/lib/db";
import { MetaApiError, metaGet } from "@/lib/meta/client";
import { mapRatingSummary } from "@/lib/meta/guest";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";

// "Có N đánh giá mới" without webhooks: each feed read also asks the Page how many ratings it has, and a count that went up
// since the previous read means new ratings. Only the numbers are kept, never the ratings. Everything here is best-effort:
// telling the user must never fail (or be able to roll back) the feed read that found it.

type OpenNotification = { id: string; params: { count?: number } | null };

/** The Page's number of ratings; null when Facebook does not say (no ratings section, no permission, an outage). */
export async function readRatingCount(token: string, facebookPageId: string): Promise<number | null> {
  try {
    return mapRatingSummary(await metaGet(facebookPageId, token, { fields: "rating_count" })).count;
  } catch (e) {
    // A Page without a ratings section (100) or without the permission (10/200), or a hiccup: not worth a line on every
    // read of every Page, and never a reason to fail the feed read.
    if (!(e instanceof MetaApiError && ["100", "10", "200"].includes(e.code))) console.warn(`ratings: the count of ${facebookPageId} could not be read:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function openNotifications(userId: string, pageRowId: string) {
  const { data, error } = await userDb(userId).notifications.select("id,params")
    .eq("type", "NEW_RATINGS").eq("page_id", pageRowId).is("read_at", null);
  if (error) throw error;
  return rows<OpenNotification>(data);
}

async function storedCount(userId: string, pageRowId: string): Promise<{ found: boolean; count: number | null }> {
  const { data, error } = await userDb(userId).pages.select("ratings_count").eq("id", pageRowId).maybeSingle();
  if (error) throw error;
  const row = one<{ ratings_count: number | null }>(data);
  return { found: row !== null, count: row?.ratings_count ?? null };
}

/**
 * Compares the count just read with the stored one. The first count only sets the mark (nothing is announced for ratings that
 * were already there); a lower one (a rating was removed) lowers it; a higher one is "N new", added to the open notification of
 * the Page or starting a new one. The stored count is changed only if nobody changed it since it was read, so two reads running
 * at once cannot count the same ratings twice; and it is stored BEFORE telling, so a retried read cannot either.
 */
export async function recordRatingCount(userId: string, pageRowId: string, live: number, now: Date) {
  try {
    const stored = await storedCount(userId, pageRowId);
    if (!stored.found) return;
    const before = stored.count;
    if (live === before) return;
    const db = userDb(userId);
    const swap = db.pages.update({ ratings_count: live }).eq("id", pageRowId);
    const { data, error } = await (before === null ? swap.is("ratings_count", null) : swap.eq("ratings_count", before)).select("id");
    if (error) throw error;
    if (!rows(data).length || before === null || live < before) return; // lost the race, the first count, or a rating was removed

    const added = live - before;
    const [current] = await openNotifications(userId, pageRowId);
    if (current) {
      const { data: updated, error: updateError } = await db.notifications
        .update({ params: { ...current.params, count: (current.params?.count ?? 0) + added }, created_at: now.toISOString() })
        .eq("id", current.id).is("read_at", null).select("id"); // not if the user read it in the meantime
      if (updateError) throw updateError;
      if (rows(updated).length) return;
    }
    await notify(userId, { type: "NEW_RATINGS", dedupeKey: dedupeKeys.newRatings(pageRowId, now.getTime()), pageId: pageRowId, params: { count: added } });
  } catch (e) {
    console.error(`new ratings: recording for page ${pageRowId} failed:`, e);
  }
}

/**
 * The user opened the ratings of this Page: what is there now counts as known, and the "new ratings" notification as read.
 * `live` is the total Facebook just gave (the best baseline there is, the stored count may be minutes old); without it the
 * stored count stays.
 */
export async function markRatingsSeen(userId: string, pageRowId: string, live: number | null) {
  try {
    const stored = await storedCount(userId, pageRowId);
    if (!stored.found) return;
    const db = userDb(userId);
    if (live !== null && stored.count !== live) {
      const { error } = await db.pages.update({ ratings_count: live }).eq("id", pageRowId);
      if (error) throw error;
    }
    const open = await openNotifications(userId, pageRowId);
    if (open.length) {
      const { error } = await db.notifications.update({ read_at: new Date().toISOString() }).in("id", open.map((n) => n.id)).is("read_at", null);
      if (error) throw error;
    }
  } catch (e) {
    console.error("new ratings: marking the ratings as seen failed:", e);
  }
}
