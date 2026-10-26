"use client";

import { clearAllDrafts } from "@/lib/draft-storage";

/** The sign-out button. The copies of unposted text that forms keep in this browser go with the session. */
export default function LogoutForm({ className }: { className: string }) {
  return <form action="/api/auth/logout" method="post" onSubmit={() => { try { clearAllDrafts(window.localStorage); } catch { /* storage blocked: nothing kept */ } }}>
    <button className={className} type="submit">Đăng xuất</button>
  </form>;
}
