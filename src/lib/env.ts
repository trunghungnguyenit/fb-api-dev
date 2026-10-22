import { z } from "zod";
import { buildKeyring } from "@/lib/crypto-core";
import { buildLimits } from "@/lib/media/limits";

const schema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Either the single key, or versioned keys (see crypto-core.ts). Checked together in superRefine below.
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_ENCRYPTION_KEYS: z.string().optional(),
  APP_ENCRYPTION_KEY_ID: z.string().optional(),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
  META_OAUTH_REDIRECT_URI: z.string().url(),
  // How many posts are published at the same time (never two for the same Fanpage). The "heavy" lane is for
  // media posts (long uploads) so they cannot hold up text posts.
  PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  PUBLISH_HEAVY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  // How video / Reels files reach Facebook: "hosted" = Facebook downloads them from a temporary link (documented
  // way); "binary" = this server sends the bytes (use it if Facebook cannot reach the link).
  META_VIDEO_UPLOAD_MODE: z.enum(["hosted", "binary"]).default("hosted"),
  // Minutes between two reads of one Fanpage's posts (changes made on Facebook reach the app within about this time).
  FEED_SYNC_INTERVAL_MIN: z.coerce.number().int().min(1).max(60).default(5),
  CRON_SECRET: z.string().min(24).refine((v) => !/^replace-/i.test(v), "Placeholder from .env.example, generate a real secret")
}).superRefine((value, ctx) => {
  try { buildKeyring(value); }
  catch (e) { ctx.addIssue({ code: "custom", path: ["APP_ENCRYPTION_KEYS"], message: e instanceof Error ? e.message : "Invalid encryption key configuration" }); }
  // Media size limits (MEDIA_* variables, see media/limits.ts): a wrong value must stop the app at startup.
  try { buildLimits(process.env); }
  catch (e) { ctx.addIssue({ code: "custom", path: ["MEDIA_MAX_FILE_MB"], message: e instanceof Error ? e.message : "Invalid media limits" }); }
  // The OAuth cookies/session live on APP_URL's host, so the callback must come back to that same origin.
  const app = new URL(value.NEXT_PUBLIC_APP_URL);
  const redirect = new URL(value.META_OAUTH_REDIRECT_URI);
  if (app.origin !== redirect.origin) {
    ctx.addIssue({ code: "custom", path: ["META_OAUTH_REDIRECT_URI"], message: `Origin must equal NEXT_PUBLIC_APP_URL (${app.origin})` });
  }
  if (redirect.pathname !== "/api/auth/facebook/callback") {
    ctx.addIssue({ code: "custom", path: ["META_OAUTH_REDIRECT_URI"], message: "Path must be /api/auth/facebook/callback" });
  }
});

export const env = schema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  APP_ENCRYPTION_KEYS: process.env.APP_ENCRYPTION_KEYS,
  APP_ENCRYPTION_KEY_ID: process.env.APP_ENCRYPTION_KEY_ID,
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_GRAPH_API_VERSION: process.env.META_GRAPH_API_VERSION || undefined,
  META_OAUTH_REDIRECT_URI: process.env.META_OAUTH_REDIRECT_URI,
  PUBLISH_CONCURRENCY: process.env.PUBLISH_CONCURRENCY || undefined,
  PUBLISH_HEAVY_CONCURRENCY: process.env.PUBLISH_HEAVY_CONCURRENCY || undefined,
  META_VIDEO_UPLOAD_MODE: process.env.META_VIDEO_UPLOAD_MODE || undefined,
  FEED_SYNC_INTERVAL_MIN: process.env.FEED_SYNC_INTERVAL_MIN || undefined,
  CRON_SECRET: process.env.CRON_SECRET
});
