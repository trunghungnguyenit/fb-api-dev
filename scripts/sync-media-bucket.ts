// Makes the Storage bucket for uploaded media match the configuration: creates it if missing, keeps it PRIVATE,
// and sets its file size limit and allowed types from the same MEDIA_* variables the app uses.
//
//   npm run media:sync-bucket              create / update the bucket
//   npm run media:sync-bucket -- --dry-run  show what would change
//
// Run it once after deploying, and again whenever MEDIA_* limits change. Needs Node >= 22.18 and the app's .env
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
//
// The project also has a global upload limit (Supabase dashboard -> Storage -> Settings, set by the plan). A bucket
// limit above it cannot be reached; the script reports it when Supabase refuses the value.
import { createClient } from "@supabase/supabase-js";
import { buildLimits } from "../src/lib/media/limits.ts";
import { BUCKET_MIME_TYPES, MEDIA_BUCKET } from "../src/lib/media/types.ts";

const dryRun = process.argv.includes("--dry-run");
for (const arg of process.argv.slice(2)) if (arg !== "--dry-run") throw new Error(`Unknown option ${arg}`);

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const limits = buildLimits(process.env);
const wanted = { public: false, fileSizeLimit: limits.maxFileBytes, allowedMimeTypes: [...BUCKET_MIME_TYPES] };
const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;

const db = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false }
});

const { data: existing, error: lookupError } = await db.storage.getBucket(MEDIA_BUCKET);
const missing = !existing && lookupError && /not.?found|does not exist/i.test(lookupError.message);
if (lookupError && !missing) throw new Error(`Cannot read bucket "${MEDIA_BUCKET}": ${lookupError.message}`);

console.log(`Bucket "${MEDIA_BUCKET}": private, ${mb(wanted.fileSizeLimit)} per file, types ${wanted.allowedMimeTypes.join(", ")}`);

if (missing) {
  console.log(dryRun ? "Would create the bucket." : "Creating the bucket...");
  if (!dryRun) {
    const { error } = await db.storage.createBucket(MEDIA_BUCKET, wanted);
    if (error) throw new Error(`Creating the bucket failed: ${error.message}`);
    console.log("Created.");
  }
} else if (existing) {
  const problems: string[] = [];
  if (existing.public) problems.push("it was PUBLIC (now made private)");
  if (existing.file_size_limit !== wanted.fileSizeLimit) problems.push(`file size limit was ${existing.file_size_limit ?? "none"} (now ${wanted.fileSizeLimit})`);
  const sameTypes = (existing.allowed_mime_types ?? []).slice().sort().join() === [...wanted.allowedMimeTypes].sort().join();
  if (!sameTypes) problems.push("allowed types differed");
  if (!problems.length) console.log("Already up to date.");
  else {
    console.log(`${dryRun ? "Would update" : "Updating"}: ${problems.join("; ")}.`);
    if (!dryRun) {
      const { error } = await db.storage.updateBucket(MEDIA_BUCKET, wanted);
      if (error) throw new Error(`Updating the bucket failed: ${error.message} (is ${mb(wanted.fileSizeLimit)} above the project's global upload limit?)`);
      console.log("Updated.");
    }
  }
}
