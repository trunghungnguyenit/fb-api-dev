// What the browser is told about how to treat the app's pages. Pure module (used by next.config.ts and the middleware).
//
// What this CAN do: stop the app being framed, stop scripts from other places running if one is ever injected, keep the browser
// from guessing types or leaking the address, and keep authenticated answers out of shared caches. What it cannot do is hide what
// the browser has to receive to draw a page: that is visible in DevTools by design, so the protection is not sending more than
// is needed (see lib/post-public.ts) and checking everything on the server.

export type Header = { key: string; value: string };

/** Sent with every response. HSTS is ignored by browsers on plain http, so it is safe on localhost. */
export const SECURITY_HEADERS: readonly Header[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" }
];

/** What the API answers are for one browser only: nothing in between may keep a copy. */
export const API_HEADERS: readonly Header[] = [{ key: "Cache-Control", value: "no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }];

export const CSP_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_REPORT_PATH = "/api/csp-report";

/** The origin of a URL ("https://x.supabase.co"), or null when it is not one. */
export function originOf(url: string | undefined): string | null {
  try { return url ? new URL(url).origin : null; } catch { return null; }
}

/**
 * The content security policy of a page. Scripts run only with this response's nonce (and what those scripts load themselves,
 * `strict-dynamic`); everything else only comes from the app or, for pictures, uploads and their previews, from the Supabase
 * Storage of the project. `form-action` is left out on purpose: the sign-in form ends in a redirect to Google, which some browsers
 * check against it.
 */
export function buildCsp({ nonce, dev = false, supabaseUrl }: { nonce: string; dev?: boolean; supabaseUrl?: string }): string {
  const supabase = originOf(supabaseUrl);
  const withSupabase = (...sources: string[]) => [...sources, ...(supabase ? [supabase] : [])].join(" ");
  return [
    "default-src 'self'",
    // React's development build needs eval for stack traces; the production build never does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Components set inline style attributes (widths of bars, sizes of skeletons): they cannot carry a nonce.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${withSupabase("'self'", "data:", "blob:")}`,
    `media-src ${withSupabase("'self'", "blob:")}`,
    "font-src 'self' data:",
    `connect-src ${withSupabase("'self'")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`
  ].join("; ");
}

/** The pages anyone may open: the sign-in page, where Google sends the user back to, and the two legal pages. Everything else needs a session. */
export const PUBLIC_PAGES = ["/login", "/auth/callback", "/privacy", "/terms"] as const;
export const isPublicPage = (pathname: string) => PUBLIC_PAGES.some((page) => pathname === page || pathname === `${page}/`);

/** A fresh, unguessable value for one response. */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
