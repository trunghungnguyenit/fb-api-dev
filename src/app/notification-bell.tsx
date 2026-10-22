import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { countUnread } from "@/lib/notifications";

// Floating bell with the unread count, shown to signed-in users on every page. The user id comes from the
// verified session JWT (same check the middleware does), and only a count is shown: the list itself lives on
// /notifications, which authorizes with requireUser().
export default async function NotificationBell() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const unread = await countUnread(userId);
  const label = unread > 0 ? `Thông báo (${unread} chưa đọc)` : "Thông báo";
  return <Link href="/notifications" className="notif-bell" aria-label={label} title={label}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {unread > 0 && <span className="notif-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
  </Link>;
}
