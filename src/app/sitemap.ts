import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { INDEXABLE_PATHS, siteOrigin } from "@/lib/site";

// Only the pages that may be listed. A date is left out on purpose: a "last changed" that is not true is worse than none.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin(env.NEXT_PUBLIC_APP_URL);
  if (!origin) return [];
  return INDEXABLE_PATHS.map((path) => ({ url: `${origin}${path}`, changeFrequency: "monthly" as const, priority: path === "/login" ? 1 : 0.4 }));
}
