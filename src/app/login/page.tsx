import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import JsonLd from "@/app/json-ld";
import { messageFor } from "@/lib/errors";
import { pageMetadata, SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "@/lib/site";

/* eslint-disable @next/next/no-img-element */
export const dynamic = "force-dynamic";

// The one page of the app a search engine can reach. A private tool, so what it says is what the tool does, in a line.
export const metadata = pageMetadata({
  title: "Page Publisher: đăng và lên lịch bài cho Fanpage Facebook",
  description: SITE_DESCRIPTION,
  path: "/login",
  index: true
});

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
  const origin = siteOrigin(env.NEXT_PUBLIC_APP_URL);
  return <main className="shell login-shell"><section className="panel login-panel">
    <JsonLd data={{
      "@context": "https://schema.org", "@type": "WebApplication", name: SITE_NAME, description: SITE_DESCRIPTION, applicationCategory: "BusinessApplication",
      operatingSystem: "Web", inLanguage: "vi", ...(origin ? { url: `${origin}/login`, image: `${origin}/icons/icon-512.png` } : {})
    }} />
    <div className="nav-logo" aria-hidden="true"><img src="/icons/logo-tile.png" alt="" width={64} height={64} /></div>
    <h1 className="brand">Page Publisher</h1>
    <p className="subtle">Đăng nhập bằng tài khoản Google để quản lý bài đăng Facebook.</p>
    {error && <p className="error" role="alert">{messageFor("LOGIN_FAILED")}</p>}
    <form action={signInWithGoogle}>
      <button className="btn primary" type="submit">Đăng nhập bằng Google</button>
    </form>
    <nav aria-label="Pháp lý" className="legal-links">
      <Link href="/privacy">Chính sách quyền riêng tư</Link>
      <Link href="/terms">Điều khoản sử dụng</Link>
    </nav>
  </section></main>;
}
