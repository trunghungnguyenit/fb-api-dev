import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/csrf";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // A cross-site form post must not be able to log the user out; send them to the app instead.
  if (!isSameOrigin(request)) return NextResponse.redirect(new URL("/", env.NEXT_PUBLIC_APP_URL), 303);
  const supabase = await createSupabaseServerClient();
  // Local scope: sign out this browser only, not the user's other devices.
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL), 303);
}
