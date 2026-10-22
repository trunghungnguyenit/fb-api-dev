import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppFailure, messageFor, REF_PATTERN, withRef } from "@/lib/errors";
import { formatDateTime } from "@/lib/labels";
import { listNotifications } from "@/lib/notifications";
import { describeNotification } from "@/lib/notification-text";
import ClearQuery from "../clear-query";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ error?: string; ref?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { error, ref } = await searchParams;

  let notifications;
  try { notifications = await listNotifications(user.id); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }
  const unread = notifications.filter((n) => !n.read_at).length;

  return <main className="shell">
    <header className="header"><div><h1 className="brand">Thông báo</h1><div className="subtle">Bài đăng thất bại, Fanpage mất quyền và các việc cần bạn xử lý</div></div>
      <div className="actions">
        {unread > 0 && <form action="/api/notifications/read" method="post"><button className="btn" type="submit">Đánh dấu đã đọc tất cả</button></form>}
      </div>
    </header>
    {error && <ClearQuery />}
    {error && <p className="error" role="alert">{withRef(messageFor(error), ref && REF_PATTERN.test(ref) ? ref : null)}</p>}

    <section className="panel">
      {notifications.length === 0
        ? <p className="subtle">Chưa có thông báo nào.</p>
        : <ul className="notif-list">
          {notifications.map((n) => {
            const text = describeNotification(n, n.pageName);
            return <li key={n.id} className={n.read_at ? "notif-item" : "notif-item notif-unread"}>
              <div className="notif-main">
                <div className="notif-title">{!n.read_at && <span className="badge">Mới</span>}{text.title}</div>
                <p className="notif-detail">{text.detail}</p>
                <div className="subtle cell-meta">{formatDateTime(n.created_at)}</div>
              </div>
              <div className="actions">
                <Link className="btn" href={text.href}>Xem</Link>
                {!n.read_at && <form action="/api/notifications/read" method="post">
                  <input type="hidden" name="id" value={n.id} />
                  <button className="btn" type="submit">Đã đọc</button>
                </form>}
              </div>
            </li>;
          })}
        </ul>}
    </section>
  </main>;
}
