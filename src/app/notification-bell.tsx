import { cache } from "react";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { countUnread } from "@/lib/notifications";

// The bell with the unread count, shown to signed-in users on every page. On a computer it floats in the bottom-right corner
// ("float"); on a phone it sits in the top bar next to the menu button ("nav"), so it never covers the action bar or the toasts.
// Both are rendered and CSS shows one, so the count is looked up once per request. The user id comes from the verified session
// JWT (same check the middleware does), and only a count is shown: the list itself lives on /notifications, which authorizes
// with requireUser().
const unreadOfSession = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  return userId ? countUnread(userId) : null;
});

export default async function NotificationBell({ placement = "float" }: { placement?: "float" | "nav" }) {
  const unread = await unreadOfSession();
  if (unread === null) return null;
  const label = unread > 0 ? `Thông báo (${unread} chưa đọc)` : "Thông báo";
  return <Link href="/notifications" className={`notif-bell notif-bell-${placement}`} aria-label={label} title={label}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {unread > 0 && <span className="notif-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
  </Link>;
}
