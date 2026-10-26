import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { IconBell, IconChart, IconFlag, IconHome, IconList, IconUpload } from "./icons";
import LogoutForm from "./logout-form";
import MobileMenu from "./mobile-menu";
import NavLinks, { type NavItem } from "./nav-links";
import NotificationBell from "./notification-bell";

const ITEMS: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: <IconHome /> },
  { href: "/pages", label: "Fanpage", icon: <IconFlag /> },
  { href: "/posts", label: "Bài viết", icon: <IconList /> },
  { href: "/posts/import", label: "Nhập bài", icon: <IconUpload /> },
  { href: "/insights", label: "Insights", icon: <IconChart /> },
  { href: "/notifications", label: "Thông báo", icon: <IconBell /> }
];

// Top navigation shown on every page to a signed-in user. On a computer: logo, the sections and the account. On a phone: logo, the
// bell and a menu button that opens a drawer with the sections and the account (see mobile-menu.tsx). The identity comes from the verified session JWT (the same
// check the middleware and the notification bell use); signed-out pages (login) get no navigation.
// The logo is a small static picture from /public: next/image would add nothing for a 36px file that never changes.
/* eslint-disable @next/next/no-img-element */
export default async function AppNav() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const email = typeof claims.email === "string" ? claims.email : "";
  return <nav className="neo-nav" aria-label="Điều hướng chính">
    <Link className="nav-brand" href="/"><span className="nav-logo" aria-hidden="true"><img src="/icons/logo-tile.png" alt="" width={36} height={36} /></span>Page Publisher</Link>
    <NavLinks items={ITEMS} />
    <div className="nav-mobile">
      <NotificationBell placement="nav" />
      <MobileMenu items={ITEMS} email={email} />
    </div>
    <div className="nav-account">
      {email && <span className="nav-email" title={email}>{email}</span>}
      <LogoutForm className="btn small" />
    </div>
  </nav>;
}
