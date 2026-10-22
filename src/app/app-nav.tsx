import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { IconBell, IconFeather, IconFlag, IconHome, IconList, IconUpload } from "./icons";
import NavLinks, { type NavItem } from "./nav-links";

const ITEMS: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: <IconHome /> },
  { href: "/pages", label: "Fanpage", icon: <IconFlag /> },
  { href: "/posts", label: "Bài viết", icon: <IconList /> },
  { href: "/posts/import", label: "Nhập bài", icon: <IconUpload /> },
  { href: "/notifications", label: "Thông báo", icon: <IconBell /> }
];

// Top navigation shown on every page to a signed-in user. The identity comes from the verified session JWT (the same
// check the middleware and the notification bell use); signed-out pages (login) get no navigation.
export default async function AppNav() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const email = typeof claims.email === "string" ? claims.email : "";
  return <nav className="neo-nav" aria-label="Điều hướng chính">
    <Link className="nav-brand" href="/"><span className="nav-logo" aria-hidden="true"><IconFeather /></span>Page Publisher</Link>
    <NavLinks items={ITEMS} />
    <div className="nav-account">
      {email && <span className="nav-email" title={email}>{email}</span>}
      <form action="/api/auth/logout" method="post"><button className="btn small" type="submit">Đăng xuất</button></form>
    </div>
  </nav>;
}
