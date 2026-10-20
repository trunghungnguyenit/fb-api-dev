import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });
  // getClaims verifies the JWT locally (asymmetric keys) and only calls the Auth server when it has to
  // refresh, instead of a network round-trip on every request. Pages still authorize via requireUser().
  await supabase.auth.getClaims();
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"]
};
