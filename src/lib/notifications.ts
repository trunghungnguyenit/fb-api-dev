import { rows, userDb } from "@/lib/db";
import type { NotificationParams, NotificationType } from "@/lib/notification-text";

export type StoredNotification = {
  id: string;
  type: NotificationType;
  code: string | null;
  params: NotificationParams | null;
  page_id: string | null;
  post_id: string | null;
  created_at: string;
  read_at: string | null;
};

export type NotificationInput = {
  type: NotificationType;
  dedupeKey: string;
  pageId?: string;
  postId?: string;
  code?: string;
  params?: NotificationParams;
};

/**
 * Records a notification for a user. Best-effort like the post audit log: it never throws, because telling the
 * user must not break (or be able to roll back) the job that detected the problem. Repeating the same
 * `dedupeKey` is a no-op.
 */
export async function notify(userId: string, input: NotificationInput) {
  try {
    const { error } = await userDb(userId).notifications.insert({
      type: input.type, dedupe_key: input.dedupeKey, page_id: input.pageId ?? null, post_id: input.postId ?? null,
      code: input.code ?? null, params: input.params ?? {}
    });
    if (error && error.code !== "23505") console.error(`notify ${input.type} failed for user ${userId}:`, error);
  } catch (e) {
    console.error(`notify ${input.type} failed for user ${userId}:`, e);
  }
}

export async function countUnread(userId: string) {
  const { count, error } = await userDb(userId).notifications.select("id", { count: "exact", head: true }).is("read_at", null);
  if (error) { console.error("countUnread failed:", error); return 0; }
  return count ?? 0;
}

/** Newest first, with the name of the Fanpage each one is about (null when it has no Page or the Page is gone). */
export async function listNotifications(userId: string, limit = 50) {
  const db = userDb(userId);
  const { data, error } = await db.notifications.select("id,type,code,params,page_id,post_id,created_at,read_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const list = rows<StoredNotification>(data);
  const pageIds = [...new Set(list.map((n) => n.page_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (pageIds.length) {
    const { data: pages, error: pagesError } = await db.pages.select("id,page_name").in("id", pageIds);
    if (pagesError) throw pagesError;
    for (const p of rows<{ id: string; page_name: string }>(pages)) names.set(p.id, p.page_name);
  }
  return list.map((n) => ({ ...n, pageName: n.page_id ? names.get(n.page_id) ?? null : null }));
}

/** Marks the given notifications (or all of the user's) as read. */
export async function markNotificationsRead(userId: string, ids?: string[]) {
  let query = userDb(userId).notifications.update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (ids) query = query.in("id", ids);
  const { error } = await query;
  if (error) throw error;
}
