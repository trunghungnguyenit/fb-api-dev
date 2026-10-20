import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb, withPageNames } from "@/lib/db";
import { formatDateTime, statusLabel, truncate } from "@/lib/labels";
import { AppFailure } from "@/lib/errors";

export const dynamic = "force-dynamic";

type RecentPostRow = {
  id: string;
  page_id: string;
  message: string;
  status: string;
  scheduled_at: string | null;
};

export default async function HomePage() {
  const user = await requireUser();
  if (!user) redirect("/login");

  const db = userDb(user.id);
  const [pages, posts, scheduled, failed, recent] = await Promise.all([
    db.pages.select("id", { count: "exact", head: true }).eq("is_active", true),
    db.posts.select("id", { count: "exact", head: true }),
    db.posts.select("id", { count: "exact", head: true }).eq("status", "scheduled"),
    db.posts.select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.posts.select("id,page_id,message,status,scheduled_at,created_at")
      .order("created_at", { ascending: false }).limit(8)
  ]);
  const failure = [pages, posts, scheduled, failed, recent].find((r) => r.error);
  if (failure) throw new AppFailure("DB_ERROR", failure.error);
  let recentPosts;
  try { recentPosts = await withPageNames(db, rows<RecentPostRow>(recent.data)); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Page Publisher</h1><div className="subtle">Quản lý bài đăng Facebook · {user.email}</div></div>
      <div className="actions">
        <Link className="btn" href="/pages">Fanpage</Link>
        <Link className="btn" href="/posts">Bài viết</Link>
        <Link className="btn primary" href="/posts/new">+ Soạn bài</Link>
        <form action="/api/auth/logout" method="post"><button className="btn" type="submit">Đăng xuất</button></form>
      </div>
    </header>
    <section className="grid">
      <div className="panel"><div className="subtle">Fanpage đang kết nối</div><div className="stat">{pages.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Tổng bài viết</div><div className="stat">{posts.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Đang chờ đăng</div><div className="stat">{scheduled.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Bài đăng lỗi</div><div className="stat">{failed.count ?? 0}</div></div>
    </section>
    <section className="panel">
      <h2>Bài viết gần đây</h2>
      <div className="table-wrap"><table><thead><tr><th scope="col">Nội dung</th><th scope="col">Fanpage</th><th scope="col">Trạng thái</th><th scope="col">Lịch đăng</th></tr></thead>
        <tbody>{recentPosts.map((post) => <tr key={post.id}>
          <td>{truncate(post.message, 100)}</td>
          <td>{post.facebook_pages?.page_name ?? "—"}</td>
          <td><span className="pill">{statusLabel(post.status)}</span></td>
          <td>{post.scheduled_at ? formatDateTime(post.scheduled_at) : "—"}</td>
        </tr>)}
        {!recentPosts.length && <tr><td colSpan={4}>Chưa có bài viết.</td></tr>}</tbody>
      </table></div>
    </section>
  </main>;
}
