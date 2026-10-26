import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { INDEXABLE_PATHS, siteOrigin } from "@/lib/site";

// Crawlers may read the sign-in page and the two legal pages; everything else is private (and answers them with a redirect to the
// sign-in page anyway). The most specific rule wins, so the three "allow" lines beat the general "disallow".
export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin(env.NEXT_PUBLIC_APP_URL);
  return {
    rules: [{ userAgent: "*", allow: [...INDEXABLE_PATHS], disallow: "/" }],
    ...(origin ? { sitemap: `${origin}/sitemap.xml`, host: origin } : {})
  };
}
