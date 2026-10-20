import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "Must be 32 bytes in hex"),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
  META_OAUTH_REDIRECT_URI: z.string().url(),
  CRON_SECRET: z.string().min(24).refine((v) => !/^replace-/i.test(v), "Placeholder from .env.example, generate a real secret")
}).superRefine((value, ctx) => {
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
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_GRAPH_API_VERSION: process.env.META_GRAPH_API_VERSION || undefined,
  META_OAUTH_REDIRECT_URI: process.env.META_OAUTH_REDIRECT_URI,
  CRON_SECRET: process.env.CRON_SECRET
});
