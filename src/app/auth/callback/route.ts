import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/login?error=oauth", env.NEXT_PUBLIC_APP_URL));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    console.error("exchangeCodeForSession failed:", error?.message);
    return NextResponse.redirect(new URL("/login?error=oauth", env.NEXT_PUBLIC_APP_URL));
  }

  // Every Google account is its own user (auth.users.id); keep a profile row for it on first login.
  const user = data.user;
  const { error: profileError } = await supabaseAdmin.from("profiles").upsert(
    { id: user.id, display_name: user.user_metadata?.full_name ?? user.email ?? null },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (profileError) console.error("profile upsert failed:", profileError);

  return NextResponse.redirect(new URL("/", env.NEXT_PUBLIC_APP_URL));
}
