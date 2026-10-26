import { supabaseAdmin } from "@/lib/supabase/admin";

// Columns/tables the code relies on that were added after the first release. If the database was not
// updated with supabase/schema.sql, every page that touches them would fail with a cryptic error, so the
// root layout checks them once and shows a clear "update the database" message instead.
const REQUIRED: { table: string; columns: string }[] = [
  { table: "posts", columns: "sent_at,edited_at,facebook_deleted_at,reposted_from,import_batch_id,note,next_attempt_at,post_type,publish_phase,facebook_video_id,processing_since,phase_checked_at,facebook_checked_at" },
  { table: "import_batches", columns: "id,undone_at" },
  { table: "facebook_pages", columns: "removed_at,feed_synced_at,feed_next_sync_at,feed_sync_error,ratings_count" },
  { table: "facebook_connections", columns: "last_checked_at,token_checked_at,token_is_valid,data_access_expires_at" },
  { table: "post_events", columns: "id,type" },
  { table: "notifications", columns: "id,type,dedupe_key,read_at" },
  { table: "page_feed_posts", columns: "id,page_id,facebook_post_id,created_time,absent_checks,missing_since,post_id,comments_seen_count" },
  { table: "comment_actions", columns: "id,page_id,post_kind,facebook_comment_id,action,result" },
  { table: "post_media", columns: "id,post_id,kind,storage_path,state,size_bytes,position,facebook_media_id" }
];

/** Postgres undefined column / table / function, and PostgREST "not in schema cache" for tables, columns and functions. */
export function isMissingSchemaError(error: { code?: string } | null | undefined) {
  return Boolean(error?.code && ["42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error.code));
}

export type SchemaStatus = { ok: true } | { ok: false; missing: string[] };

let verified = false;

/**
 * Cheap `select ... limit 0` per table. A positive result is cached for the life of the process; a failure
 * is re-checked on every call so the page recovers right after the SQL is run. Anything that is not a
 * "missing column/table" error (network blip, outage) is NOT reported as an outdated schema.
 */
export async function checkSchema(): Promise<SchemaStatus> {
  if (verified) return { ok: true };
  const missing: string[] = [];
  const results = await Promise.all(REQUIRED.map(async ({ table, columns }) => {
    const { error } = await supabaseAdmin.from(table).select(columns).limit(0);
    return { table, columns, error };
  }));
  // SQL functions the import feature calls (probed with empty arguments).
  const nobody = "00000000-0000-0000-0000-000000000000";
  const functions = await Promise.all([
    supabaseAdmin.rpc("find_duplicate_posts", { p_user: nobody, p_page_ids: [], p_messages: [] }).then((r) => ({ name: "find_duplicate_posts", error: r.error })),
    supabaseAdmin.rpc("import_batch_stats", { p_user: nobody }).then((r) => ({ name: "import_batch_stats", error: r.error })),
    supabaseAdmin.rpc("page_post_counts", { p_user: nobody, p_page: null }).then((r) => ({ name: "page_post_counts", error: r.error }))
  ]);
  for (const { name, error } of functions) {
    if (isMissingSchemaError(error)) missing.push(`function ${name}()`);
    else if (error) console.error(`schema check for ${name} failed (not a missing function):`, error);
  }

  for (const { table, columns, error } of results) {
    if (isMissingSchemaError(error)) missing.push(`${table}(${columns})`);
    else if (error) console.error(`schema check for ${table} failed (not a missing column):`, error);
  }
  if (missing.length) {
    console.error(`DATABASE SCHEMA OUTDATED, run supabase/schema.sql. Missing: ${missing.join("; ")}`);
    return { ok: false, missing };
  }
  verified = true;
  return { ok: true };
}
