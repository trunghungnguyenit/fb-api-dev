import { supabaseAdmin } from "@/lib/supabase/admin";

// Every user-facing query goes through here so `user_id` is applied automatically and
// cannot be forgotten (the service-role client bypasses RLS). System jobs (cron/publisher)
// that legitimately span users use supabaseAdmin directly and filter on the row's own user_id.
type Table = "posts" | "facebook_pages" | "facebook_connections" | "publish_attempts" | "post_events" | "import_batches" | "notifications" | "post_media" | "page_feed_posts" | "comment_actions";
type SelectOptions = { head?: boolean; count?: "exact" | "planned" | "estimated" };

function scoped(table: Table, userId: string) {
  return {
    select: (columns?: string, options?: SelectOptions) =>
      supabaseAdmin.from(table).select(columns, options).eq("user_id", userId),
    update: (values: Record<string, unknown>) =>
      supabaseAdmin.from(table).update(values).eq("user_id", userId),
    delete: () => supabaseAdmin.from(table).delete().eq("user_id", userId),
    insert: (row: Record<string, unknown> | Record<string, unknown>[]) =>
      supabaseAdmin.from(table).insert(
        Array.isArray(row) ? row.map((r) => ({ ...r, user_id: userId })) : { ...row, user_id: userId }),
    upsert: (row: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) =>
      supabaseAdmin.from(table).upsert(
        Array.isArray(row) ? row.map((r) => ({ ...r, user_id: userId })) : { ...row, user_id: userId }, options)
  };
}

export function userDb(userId: string) {
  return {
    posts: scoped("posts", userId),
    pages: scoped("facebook_pages", userId),
    connections: scoped("facebook_connections", userId),
    attempts: scoped("publish_attempts", userId),
    events: scoped("post_events", userId),
    imports: scoped("import_batches", userId),
    notifications: scoped("notifications", userId),
    media: scoped("post_media", userId),
    feed: scoped("page_feed_posts", userId),
    commentActions: scoped("comment_actions", userId)
  };
}

type Scoped = ReturnType<typeof userDb>;

/** Escapes \ % _ so user text is matched literally inside an ILIKE pattern. */
export function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Attaches `facebook_pages: { page_name }` to posts with a separate (user-scoped) query instead of a
 * PostgREST embed. Embeds break when posts has more than one FK to facebook_pages (PGRST201), which
 * is the case after supabase/schema.sql adds the owner-checked composite FK.
 */
export async function withPageNames<T extends { page_id: string }>(db: Scoped, posts: T[]) {
  const ids = [...new Set(posts.map((p) => p.page_id))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data, error } = await db.pages.select("id,page_name,removed_at").in("id", ids);
    if (error) throw error;
    for (const p of rows<{ id: string; page_name: string; removed_at: string | null }>(data)) {
      names.set(p.id, p.removed_at ? `${p.page_name} (đã gỡ)` : p.page_name);
    }
  }
  return posts.map((p) => ({ ...p, facebook_pages: names.has(p.page_id) ? { page_name: names.get(p.page_id)! } : null }));
}

// The client has no generated Database types and the column list is a runtime string, so the
// row shape cannot be inferred. Callers state it explicitly: rows<PostRow>(data).
export function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export function one<T>(data: unknown): T | null {
  return (data ?? null) as T | null;
}
