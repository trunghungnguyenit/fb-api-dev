import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Dummy values so modules that import "@/lib/env" load. They satisfy env.ts validation and point nowhere.
    env: {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      APP_ENCRYPTION_KEY: "0".repeat(64),
      META_APP_ID: "test-app-id",
      META_APP_SECRET: "test-app-secret",
      META_GRAPH_API_VERSION: "v26.0",
      META_OAUTH_REDIRECT_URI: "http://localhost:3000/api/auth/facebook/callback",
      CRON_SECRET: "test-cron-secret-with-enough-length"
    }
  }
});
