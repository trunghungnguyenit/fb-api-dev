import type { NextConfig } from "next";
import { API_HEADERS, SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Nothing in the browser should say what the app is made of, and the readable source of the app is not shipped to it.
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // The tags of a page (title, description, canonical, Open Graph) are written into <head> for every visitor. By default Next.js does that
  // only for the crawlers it knows by name and streams them into <body> for everyone else, which is not what a crawler it does not
  // know (a chat app that makes a link preview, a smaller search engine) can be expected to cope with. The tags here are static: no wait.
  htmlLimitedBots: /.*/,
  experimental: {
    // The stylesheet of the app is small: placing it in the page removes a request that blocks drawing the first screen.
    inlineCss: true
  },
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      { source: "/api/:path*", headers: [...API_HEADERS] }
    ];
  }
};
export default nextConfig;
