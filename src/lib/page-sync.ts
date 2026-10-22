import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { one, rows, userDb } from "@/lib/db";
import { messageFor } from "@/lib/errors";
import { inspectConnection, type ConnectionInfo } from "@/lib/connection-health";
import { notify } from "@/lib/notifications";
import { dedupeKeys } from "@/lib/notification-text";
import type { MetaPage } from "@/lib/meta/client";
import { fetchAllManagedPages, isPermissionError } from "@/lib/meta/pages";
import { CANCELLED_ON_REMOVAL, excludeRemoved } from "@/lib/page-removal";

const UPSERT_CHUNK = 100;

/**
 * Turns a Page off. Its queued posts STAY `scheduled`: they are only flagged PAGE_INACTIVE (shown to
 * the user, skipped by the publisher) and resume automatically when the Page is reconnected.
 * Nothing is failed or lost, so a wrong deactivation is harmless and self-heals.
 */
export async function deactivatePage(userId: string, pageRowId: string, opts: { notifyUser?: boolean } = {}) {
  const db = userDb(userId);
  // Only a Page that was active just now changes state (and tells the user): switching off an already
  // inactive Page again, as repeated failures do, must not notify again.
  const { data: switchedOff, error } = await db.pages.update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", pageRowId).eq("is_active", true).select("id");
  if (error) { console.error(`deactivatePage failed for ${pageRowId}:`, error); return false; }
  // A whole connection going dead switches off many Pages at once: the caller sends ONE notification for it.
  if (opts.notifyUser !== false && rows<{ id: string }>(switchedOff).length) {
    await notify(userId, {
      type: "PAGE_ACCESS_LOST", pageId: pageRowId, dedupeKey: dedupeKeys.pageAccessLost(pageRowId, new Date().toISOString().slice(0, 10))
    });
  }
  const { error: postsError } = await db.posts.update({
    last_error_code: "PAGE_INACTIVE", last_error_message: messageFor("PAGE_INACTIVE"),
    updated_at: new Date().toISOString()
  }).eq("page_id", pageRowId).eq("status", "scheduled");
  if (postsError) console.error(`flagging queued posts of page ${pageRowId} failed:`, postsError);
  return true;
}

/** A Page is active again: release its queued posts back to the publisher. */
async function reactivatePosts(userId: string, pageRowIds: string[]) {
  if (!pageRowIds.length) return;
  const { error } = await userDb(userId).posts.update({
    last_error_code: null, last_error_message: null, updated_at: new Date().toISOString()
  }).in("page_id", pageRowIds).eq("status", "scheduled").eq("last_error_code", "PAGE_INACTIVE");
  if (error) console.error("releasing queued posts failed:", error);
}

/** Bulk-upserts Pages (and re-activates them), attaching them to `connectionId` with a fresh token. */
async function upsertPages(userId: string, connectionId: string, allPages: MetaPage[]) {
  const db = userDb(userId);
  // Pages the user removed stay removed: only an explicit "Kết nối lại" brings them back.
  const { data: removedData } = await db.pages.select("page_id").not("removed_at", "is", null);
  const pages = excludeRemoved(allPages, new Set(rows<{ page_id: string }>(removedData).map((p) => p.page_id)));
  const valid = pages.filter((p) => p.access_token);
  const result = { saved: 0, failed: pages.length - valid.length };
  for (let i = 0; i < valid.length; i += UPSERT_CHUNK) {
    const chunk = valid.slice(i, i + UPSERT_CHUNK);
    const { error } = await db.pages.upsert(chunk.map((page) => ({
      connection_id: connectionId,
      page_id: page.id,
      page_name: page.name,
      page_access_token_encrypted: encryptSecret(page.access_token),
      tasks: page.tasks ?? [],
      is_active: true,
      updated_at: new Date().toISOString()
    })), { onConflict: "user_id,page_id" });
    if (error) { result.failed += chunk.length; console.error("facebook_pages bulk upsert failed:", error); }
    else result.saved += chunk.length;
  }
  return result;
}

type ConnectionRow = ConnectionInfo & { user_token_encrypted: string; token_is_valid?: boolean | null };

/** Columns every connection check needs (the token, plus what the health check compares and reports). */
const CONNECTION_COLUMNS = "id,user_id,user_token_encrypted,meta_user_name,scopes,token_is_valid";

/**
 * A Page missing from this connection may still be managed through ANOTHER Facebook account of the same
 * user (a Page is stored once per user and re-pointed to whichever connection synced last). Re-attach it
 * to such a connection instead of switching it off.
 */
async function rescueFromOtherConnections(userId: string, connectionId: string, missingPageIds: string[]) {
  const rescued = new Set<string>();
  const { data } = await userDb(userId).connections.select("id,user_id,user_token_encrypted").neq("id", connectionId);
  for (const other of rows<ConnectionRow>(data)) {
    if (rescued.size === missingPageIds.length) break;
    try {
      const pages = await fetchAllManagedPages(decryptSecret(other.user_token_encrypted));
      const mine = pages.filter((p) => missingPageIds.includes(p.id) && !rescued.has(p.id));
      if (!mine.length) continue;
      await upsertPages(userId, other.id, mine);
      mine.forEach((p) => rescued.add(p.id));
    } catch (e) {
      console.error(`rescue via connection ${other.id} failed:`, e);
    }
  }
  return rescued;
}

export type SyncResult = { saved: number; failed: number; deactivated: number };

/**
 * Makes the DB match the Pages Meta currently returns for this connection: upserts (and re-activates)
 * the present ones, deactivates the ones that disappeared. `pages` must be the COMPLETE list.
 */
export async function syncConnectionPages(userId: string, connectionId: string, pages: MetaPage[]): Promise<SyncResult> {
  const db = userDb(userId);
  const { saved, failed } = await upsertPages(userId, connectionId, pages);
  const result: SyncResult = { saved, failed, deactivated: 0 };
  const seen = new Set(pages.map((p) => p.id));

  const { data, error } = await db.pages.select("id,page_id,is_active,removed_at").eq("connection_id", connectionId);
  if (error) { console.error("listing connection pages failed:", error); return result; }
  // Removed Pages are out of the picture: never re-activated, never counted as "missing".
  const known = rows<{ id: string; page_id: string; is_active: boolean; removed_at: string | null }>(data).filter((p) => !p.removed_at);

  await reactivatePosts(userId, known.filter((p) => seen.has(p.page_id)).map((p) => p.id));

  // An empty list is indistinguishable from a transient Graph hiccup; never switch Pages off because of it.
  // A genuinely dead token still gets caught per-Page when a publish hits error 190 / 102 / 467.
  if (pages.length === 0) {
    if (known.some((p) => p.is_active)) console.warn(`me/accounts returned no pages for connection ${connectionId}; skipping deactivation`);
    return result;
  }

  const missing = known.filter((p) => p.is_active && !seen.has(p.page_id));
  if (!missing.length) return result;
  const rescued = await rescueFromOtherConnections(userId, connectionId, missing.map((p) => p.page_id));
  await reactivatePosts(userId, missing.filter((p) => rescued.has(p.page_id)).map((p) => p.id));
  for (const row of missing) {
    if (rescued.has(row.page_id)) continue;
    if (await deactivatePage(userId, row.id)) result.deactivated++;
  }
  return result;
}

/**
 * The user token itself is dead: every Page under this connection has lost access. They are switched off
 * (their queued posts stay queued) and the user gets ONE notification, not one per Page.
 */
async function switchOffConnection(connection: ConnectionRow): Promise<SyncResult> {
  const db = userDb(connection.user_id);
  const { data: raw } = await db.pages.select("id").eq("connection_id", connection.id).eq("is_active", true);
  let deactivated = 0;
  for (const row of rows<{ id: string }>(raw)) {
    if (await deactivatePage(connection.user_id, row.id, { notifyUser: false })) deactivated++;
  }
  const { error } = await db.connections.update({ token_is_valid: false, token_checked_at: new Date().toISOString() }).eq("id", connection.id);
  if (error) console.error(`marking connection ${connection.id} invalid failed:`, error);
  // Tell the user when something changed (Pages switched off, or the token just turned invalid), not on every re-check.
  if (deactivated > 0 || connection.token_is_valid !== false) {
    await notify(connection.user_id, {
      type: "REAUTH_REQUIRED", dedupeKey: dedupeKeys.reauthRequired(connection.id, new Date().toISOString().slice(0, 10)),
      params: { connectionName: connection.meta_user_name ?? undefined }
    });
  }
  return { saved: 0, failed: 0, deactivated };
}

/** Re-validates one Facebook connection against Meta and syncs its Pages. */
export async function checkConnection(connection: ConnectionRow): Promise<SyncResult> {
  const userToken = decryptSecret(connection.user_token_encrypted);
  // Ask Meta directly first: it says whether the token is dead and when access ends, and warns the user in time.
  // No verdict (null) is not "dead": the Pages call below is still the safety net.
  if (await inspectConnection(connection, userToken) === false) return switchOffConnection(connection);

  let pages: MetaPage[];
  try {
    pages = await fetchAllManagedPages(userToken);
  } catch (e) {
    if (!isPermissionError(e)) throw e;
    return switchOffConnection(connection);
  }
  return syncConnectionPages(connection.user_id, connection.id, pages);
}

export async function checkUserConnections(userId: string): Promise<SyncResult & { errors: number }> {
  const { data, error } = await userDb(userId).connections.select(CONNECTION_COLUMNS);
  if (error) throw error;
  const total = { saved: 0, failed: 0, deactivated: 0, errors: 0 };
  for (const connection of rows<ConnectionRow>(data)) {
    try {
      const r = await checkConnection(connection);
      total.saved += r.saved; total.failed += r.failed; total.deactivated += r.deactivated;
    } catch (e) {
      total.errors++;
      console.error(`checkConnection failed for ${connection.id}:`, e);
    }
  }
  return total;
}

const STALE_CHECK_MS = 20 * 60 * 60 * 1000;
const CHECK_BUDGET_MS = 45_000;
const CHECK_CONCURRENCY = 5;
const CHECK_BATCH = 500;

/**
 * System job (cron). Only connections not checked in the last ~20h are processed, oldest first, a few at a
 * time, and it stops pulling new work when the time budget is used up. Call it as often as you like (hourly
 * is fine): restarts and repeated calls do no extra work, and a backlog is finished across invocations.
 */
export async function checkAllConnections(opts: { staleAfterMs?: number; budgetMs?: number; concurrency?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? CHECK_BUDGET_MS;
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_CHECK_MS)).toISOString();

  const { data, error } = await supabaseAdmin.from("facebook_connections")
    .select(CONNECTION_COLUMNS)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(CHECK_BATCH);
  if (error) throw error;

  const queue = rows<ConnectionRow>(data);
  const total = { checked: 0, remaining: 0, deactivated: 0, errors: 0 };
  let next = 0;

  async function worker() {
    while (next < queue.length && Date.now() - started < budget) {
      const connection = queue[next++];
      try {
        total.deactivated += (await checkConnection(connection)).deactivated;
      } catch (e) {
        total.errors++;
        console.error(`checkConnection failed for ${connection.id}:`, e);
      }
      total.checked++;
      // Stamped even on failure, so one broken connection cannot sit at the head of the queue forever.
      const { error: stampError } = await supabaseAdmin.from("facebook_connections")
        .update({ last_checked_at: new Date().toISOString() }).eq("id", connection.id);
      if (stampError) console.error("last_checked_at update failed:", stampError);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? CHECK_CONCURRENCY }, worker));
  total.remaining = queue.length - next;
  return total;
}

// ---------------------------------------------------------------------------------------------------------
// Removing ("gỡ") a Fanpage the user no longer wants in the app.
// ---------------------------------------------------------------------------------------------------------

export type RemoveOutcome = { ok: true; cancelled: number } | { ok: false; reason: "not_found" | "publishing" };

/**
 * Disconnects a Fanpage but KEEPS its row, so its published posts keep their history:
 *  - the stored token is wiped and the Page is switched off and marked removed (sync will not revive it);
 *  - its unpublished posts (draft, scheduled, failed) are cancelled with a clear reason. A failed post whose
 *    outcome is unknown stays as it is: it may be live on Facebook.
 * Safe to call again: it finishes a removal that stopped half-way (e.g. the cancel step failed).
 */
export async function removePage(userId: string, pageRowId: string): Promise<RemoveOutcome> {
  const db = userDb(userId);
  const { data, error } = await db.pages.select("id,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw error;
  const page = one<{ id: string; removed_at: string | null }>(data);
  if (!page) return { ok: false, reason: "not_found" };

  // A post being published right now holds this Page's token: do not pull it away mid-request.
  const publishing = await db.posts.select("id", { count: "exact", head: true }).eq("page_id", pageRowId).eq("status", "publishing");
  if (publishing.error) throw publishing.error;
  if ((publishing.count ?? 0) > 0) return { ok: false, reason: "publishing" };

  const now = new Date().toISOString();
  if (!page.removed_at) {
    // First: the Page itself, so the publisher can no longer pick up its posts.
    const { error: pageError } = await db.pages.update({
      removed_at: now, is_active: false, page_access_token_encrypted: "", updated_at: now
    }).eq("id", pageRowId).is("removed_at", null);
    if (pageError) throw pageError;
  }

  const { data: cancelledData, error: cancelError } = await db.posts.update({
    status: "cancelled", scheduled_at: null, locked_at: null,
    last_error_code: "PAGE_REMOVED", last_error_message: messageFor("PAGE_REMOVED"), updated_at: now
  }).eq("page_id", pageRowId).in("status", [...CANCELLED_ON_REMOVAL])
    .or("last_error_code.is.null,last_error_code.neq.AMBIGUOUS").select("id");
  if (cancelError) throw cancelError;
  return { ok: true, cancelled: rows<{ id: string }>(cancelledData).length };
}

export type RestoreOutcome = "restored" | "not_found" | "not_removed" | "unavailable";

/**
 * "Kết nối lại": asks Facebook (with each of the user's connections) for the Page and, if it is still managed
 * by this user, re-activates the row with a fresh token. Posts cancelled by the removal stay cancelled.
 */
export async function restoreRemovedPage(userId: string, pageRowId: string): Promise<RestoreOutcome> {
  const db = userDb(userId);
  const { data, error } = await db.pages.select("id,page_id,removed_at,connection_id").eq("id", pageRowId).maybeSingle();
  if (error) throw error;
  const page = one<{ id: string; page_id: string; removed_at: string | null; connection_id: string }>(data);
  if (!page) return "not_found";
  if (!page.removed_at) return "not_removed";

  const { data: connectionData, error: connectionError } = await db.connections.select("id,user_id,user_token_encrypted");
  if (connectionError) throw connectionError;
  // Try the Page's own connection first.
  const connections = rows<ConnectionRow>(connectionData).sort((a, b) => Number(b.id === page.connection_id) - Number(a.id === page.connection_id));

  let lastError: unknown;
  let answered = false;
  for (const connection of connections) {
    try {
      const pages = await fetchAllManagedPages(decryptSecret(connection.user_token_encrypted));
      answered = true;
      const match = pages.find((p) => p.id === page.page_id && p.access_token);
      if (!match) continue;
      const { error: updateError } = await db.pages.update({
        connection_id: connection.id, page_name: match.name, tasks: match.tasks ?? [],
        page_access_token_encrypted: encryptSecret(match.access_token),
        is_active: true, removed_at: null, updated_at: new Date().toISOString(),
        feed_next_sync_at: null // read its posts from Facebook again right away
      }).eq("id", pageRowId);
      if (updateError) throw updateError;
      return "restored";
    } catch (e) {
      lastError = e;
      console.error(`restoring page ${pageRowId} via connection ${connection.id} failed:`, e);
    }
  }
  // Every connection failed to even answer (network/outage): that is an error, not "no longer allowed".
  if (!answered && lastError) throw lastError;
  return "unavailable";
}

export type DeleteRemovedOutcome = "deleted" | "not_found" | "not_removed" | "has_posts";

/** Permanently deletes a REMOVED Fanpage, only when it has no posts left (nothing to keep as history). */
export async function deleteRemovedPage(userId: string, pageRowId: string): Promise<DeleteRemovedOutcome> {
  const db = userDb(userId);
  const { data, error } = await db.pages.select("id,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw error;
  const page = one<{ id: string; removed_at: string | null }>(data);
  if (!page) return "not_found";
  if (!page.removed_at) return "not_removed";

  const posts = await db.posts.select("id", { count: "exact", head: true }).eq("page_id", pageRowId);
  if (posts.error) throw posts.error;
  if ((posts.count ?? 0) > 0) return "has_posts";

  const { error: deleteError } = await db.pages.delete().eq("id", pageRowId).not("removed_at", "is", null);
  if (deleteError) throw deleteError;
  return "deleted";
}
