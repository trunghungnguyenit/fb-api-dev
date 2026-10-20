import { supabaseAdmin } from "@/lib/supabase/admin";

// Columns/tables the code relies on that were added after the first release. If the database was not
// updated with supabase/schema.sql, every page that touches them would fail with a cryptic error, so the
// root layout checks them once and shows a clear "update the database" message instead.
const REQUIRED: { table: string; columns: string }[] = [
  { table: "posts", columns: "sent_at,edited_at,facebook_deleted_at,reposted_from" },
  { table: "facebook_connections", columns: "last_checked_at" },
  { table: "post_events", columns: "id,type" }
];

/** Postgres undefined column / undefined table, and PostgREST "not in schema cache" for tables/columns. */
export function isMissingSchemaError(error: { code?: string } | null | undefined) {
  return Boolean(error?.code && ["42703", "42P01", "PGRST204", "PGRST205"].includes(error.code));
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
