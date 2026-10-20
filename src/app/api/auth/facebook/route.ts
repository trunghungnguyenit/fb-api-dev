import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { createOAuthState } from "@/lib/oauth-state";

export const runtime = "nodejs";

export async function GET() {
  const user = await requireUser();
  // Reached by a browser link, so send the user to the login page rather than returning JSON.
  if (!user) return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL));

  const state = createOAuthState(user.id);
  const url = new URL(`https://www.facebook.com/${env.META_GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("redirect_uri", env.META_OAUTH_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  // Re-ask permissions the user declined earlier, otherwise Facebook silently skips them.
  url.searchParams.set("auth_type", "rerequest");
  url.searchParams.set("scope", "pages_show_list,pages_read_engagement,pages_manage_posts");

  const response = NextResponse.redirect(url);
  response.cookies.set("meta_oauth_state", state, {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/api/auth/facebook", maxAge: 600
  });
  return response;
}
