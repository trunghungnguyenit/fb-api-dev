import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, CSP_HEADER, isPublicPage, newNonce, SECURITY_HEADERS } from "@/lib/security-headers";
import { hardenCookie } from "@/lib/session-cookie";

// Refreshes the Supabase session cookie on page requests. Server Components cannot write cookies, so
// without this the rotated refresh token is lost and users get logged out at random.
// API routes are excluded on purpose: route handlers can set cookies themselves via requireUser().
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Middleware errors bypass error.tsx, so fail with a clear (Vietnamese) message and log the real cause.
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return new NextResponse("Hệ thống chưa được cấu hình đầy đủ. Vui lòng liên hệ quản trị viên.", {
      status: 500, headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  // One nonce per page response: Next.js puts it on its own scripts when the policy arrives in the request headers too.
  const nonce = newNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", supabaseUrl: url });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(CSP_HEADER, csp);
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        requestHeaders.set("cookie", request.headers.get("cookie") ?? "");
        response = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, hardenCookie(options, process.env.NEXT_PUBLIC_APP_URL)));
      }
    }
  });
  // getClaims verifies the JWT locally (asymmetric keys) and only calls the Auth server when it has to
  // refresh, instead of a network round-trip on every request. Pages still authorize via requireUser().
  const { data: claimsData } = await supabase.auth.getClaims();
  // Nobody signed in gets a page at all, only the way to sign in: a real redirect before anything is rendered (a page that
  // checks for itself, behind a loading screen, would answer 200 and redirect from inside the stream). Pages and APIs still
  // check the user themselves; this is the first gate, not the only one.
  if (!claimsData?.claims?.sub && !isPublicPage(request.nextUrl.pathname)) {
    // To the address the app is known by (not the Host the request came with), and 303 for anything but a read so a POST is not repeated at /login.
    const redirect = NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? request.url), request.method === "GET" || request.method === "HEAD" ? 307 : 303);
    // A session cookie the check wanted to clear goes with the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const header of SECURITY_HEADERS) redirect.headers.set(header.key, header.value);
    redirect.headers.set("Cache-Control", "no-store");
    return redirect;
  }
  // Report-only for now: a page that the policy would have broken shows up in /api/csp-report without breaking anything.
  response.headers.set(CSP_HEADER, csp);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sitemap.xml|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"]
};
