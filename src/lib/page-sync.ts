import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { rows, userDb } from "@/lib/db";
import { messageFor } from "@/lib/errors";
import type { MetaPage } from "@/lib/meta/client";
import { fetchAllManagedPages, isPermissionError } from "@/lib/meta/pages";

const UPSERT_CHUNK = 100;

/**
 * Turns a Page off. Its queued posts STAY `scheduled`: they are only flagged PAGE_INACTIVE (shown to
 * the user, skipped by the publisher) and resume automatically when the Page is reconnected.
 * Nothing is failed or lost, so a wrong deactivation is harmless and self-heals.
 */
export async function deactivatePage(userId: string, pageRowId: string) {
  const db = userDb(userId);
  const { error } = await db.pages.update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", pageRowId);
  if (error) { console.error(`deactivatePage failed for ${pageRowId}:`, error); return false; }
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
async function upsertPages(userId: string, connectionId: string, pages: MetaPage[]) {
  const db = userDb(userId);
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

type ConnectionRow = { id: string; user_id: string; user_token_encrypted: string };

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

  const { data, error } = await db.pages.select("id,page_id,is_active").eq("connection_id", connectionId);
  if (error) { console.error("listing connection pages failed:", error); return result; }
  const known = rows<{ id: string; page_id: string; is_active: boolean }>(data);

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

/** Re-validates one Facebook connection against Meta and syncs its Pages. */
export async function checkConnection(connection: ConnectionRow): Promise<SyncResult> {
  let pages: MetaPage[];
  try {
    pages = await fetchAllManagedPages(decryptSecret(connection.user_token_encrypted));
  } catch (e) {
    if (!isPermissionError(e)) throw e;
    // The user token itself is dead: every Page under this connection has lost access.
    const { data: raw } = await userDb(connection.user_id).pages.select("id")
      .eq("connection_id", connection.id).eq("is_active", true);
    let deactivated = 0;
    for (const row of rows<{ id: string }>(raw)) {
      if (await deactivatePage(connection.user_id, row.id)) deactivated++;
    }
    return { saved: 0, failed: 0, deactivated };
  }
  return syncConnectionPages(connection.user_id, connection.id, pages);
}

export async function checkUserConnections(userId: string): Promise<SyncResult & { errors: number }> {
  const { data, error } = await userDb(userId).connections.select("id,user_id,user_token_encrypted");
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
    .select("id,user_id,user_token_encrypted")
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
