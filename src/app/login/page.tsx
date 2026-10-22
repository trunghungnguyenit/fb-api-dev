import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { messageFor } from "@/lib/errors";
import { IconFeather } from "@/app/icons";

export const dynamic = "force-dynamic";

async function signInWithGoogle() {
  "use server";
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback` }
  });
  if (error || !data.url) {
    console.error("signInWithOAuth failed:", error?.message);
    redirect("/login?error=oauth");
  }
  redirect(data.url);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await requireUser()) redirect("/");
  const { error } = await searchParams;
  return <main className="shell login-shell"><section className="panel login-panel">
    <div className="nav-logo" aria-hidden="true"><IconFeather /></div>
    <h1 className="brand">Page Publisher</h1>
    <p className="subtle">Đăng nhập bằng tài khoản Google để quản lý bài đăng Facebook.</p>
    {error && <p className="error" role="alert">{messageFor("LOGIN_FAILED")}</p>}
    <form action={signInWithGoogle}>
      <button className="btn primary" type="submit">Đăng nhập bằng Google</button>
    </form>
  </section></main>;
}
