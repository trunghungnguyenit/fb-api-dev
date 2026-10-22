// Re-encrypts stored Facebook tokens with the CURRENT encryption key, in batches.
//
//   npm run reencrypt -- --report              count rows per key (nothing is changed)
//   npm run reencrypt -- --dry-run             show what would change
//   npm run reencrypt                          do it (all rows not yet on the current key)
//   npm run reencrypt -- --batch 100 --limit 1000
//
// Needs Node >= 22.18 (runs this TypeScript file directly) and the same .env as the app
// (APP_ENCRYPTION_KEY / APP_ENCRYPTION_KEYS / APP_ENCRYPTION_KEY_ID, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
//
// Rotating a key: add the new key to APP_ENCRYPTION_KEYS and point APP_ENCRYPTION_KEY_ID at it (keep the old
// one listed), restart the app, run this script until `--report` shows 0 rows on the old key, then remove it.
// Safe to stop and re-run: rows already on the current key are skipped. Never prints tokens or keys.
import { createClient } from "@supabase/supabase-js";
import { buildKeyring, decryptWith, encryptWith, keyIdOf } from "../src/lib/crypto-core.ts";

const TARGETS = [
  { table: "facebook_connections", column: "user_token_encrypted" },
  { table: "facebook_pages", column: "page_access_token_encrypted" }
] as const;

type Row = { id: string } & Record<string, string | null>;
type Totals = { scanned: number; byKey: Map<string, number>; migrated: number; skipped: number; failed: number };

function parseArgs(argv: string[]) {
  const args = { report: false, dryRun: false, batch: 200, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") args.report = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--batch" || arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a positive integer`);
      if (arg === "--batch") args.batch = Math.min(value, 1000); else args.limit = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  return args;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keyring = buildKeyring({
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    APP_ENCRYPTION_KEYS: process.env.APP_ENCRYPTION_KEYS,
    APP_ENCRYPTION_KEY_ID: process.env.APP_ENCRYPTION_KEY_ID
  });
  const db = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  console.log(`Current key: "${keyring.currentId}" · configured keys: ${[...keyring.keys.keys()].join(", ")}`);
  if (args.report) console.log("Mode: report (no changes)"); else if (args.dryRun) console.log("Mode: dry run (no changes)");

  let remaining = args.limit;
  let hadFailures = false;

  for (const { table, column } of TARGETS) {
    const totals: Totals = { scanned: 0, byKey: new Map(), migrated: 0, skipped: 0, failed: 0 };
    let after = "00000000-0000-0000-0000-000000000000"; // below every real uuid
    while (remaining > 0 || args.report) {
      // Keyset pagination on the primary key: stable while rows are being updated.
      const { data, error } = await db.from(table).select(`id,${column}`).gt("id", after).order("id").limit(args.batch);
      if (error) throw new Error(`${table}: reading failed: ${error.message}`);
      const batch = (data ?? []) as unknown as Row[];
      if (!batch.length) break;
      after = batch[batch.length - 1].id;

      for (const row of batch) {
        const stored = row[column];
        totals.scanned++;
        // Empty = a removed Page whose token was wiped. Nothing to protect.
        if (!stored) { totals.skipped++; continue; }
        const keyId = keyIdOf(stored);
        const label = keyId ?? "(unrecognised)";
        totals.byKey.set(label, (totals.byKey.get(label) ?? 0) + 1);
        if (args.report || keyId === keyring.currentId) { totals.skipped++; continue; }
        if (remaining <= 0) { totals.skipped++; continue; }
        remaining--;
        try {
          const plain = decryptWith(keyring, stored);
          const next = encryptWith(keyring, plain);
          // Prove the new value reads back before it replaces the old one.
          if (decryptWith(keyring, next) !== plain) throw new Error("round-trip mismatch");
          if (args.dryRun) { totals.migrated++; continue; }
          // Conditional on the old value: a token refreshed while we ran is never overwritten.
          const { data: updated, error: updateError } = await db.from(table).update({ [column]: next })
            .eq("id", row.id).eq(column, stored).select("id");
          if (updateError) throw new Error(updateError.message);
          if (updated?.length) totals.migrated++; else totals.skipped++;
        } catch (e) {
          totals.failed++;
          hadFailures = true;
          console.error(`  ${table} ${row.id}: ${e instanceof Error ? e.message : "failed"}`);
        }
      }
      if (remaining <= 0 && !args.report) break;
    }

    const perKey = [...totals.byKey].map(([id, n]) => `${id}: ${n}`).join(", ") || "none";
    console.log(`${table}.${column}: scanned ${totals.scanned} · on key → ${perKey}`
      + (args.report ? "" : ` · ${args.dryRun ? "would migrate" : "migrated"} ${totals.migrated} · skipped ${totals.skipped} · failed ${totals.failed}`));
  }

  if (hadFailures) { console.error("Finished with failures: rows above were left unchanged. Re-run to retry."); process.exitCode = 1; }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
