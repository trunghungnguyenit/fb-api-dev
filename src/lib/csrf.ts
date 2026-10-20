import type { NextRequest } from "next/server";

/**
 * CSRF defence for state-changing requests authenticated by cookie. Works behind proxies and on any host
 * (it compares against the Host the browser actually used, not a configured URL).
 * Non-browser clients send neither header and are allowed: CSRF needs a browser carrying the cookie.
 */
export function isSameOrigin(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}
