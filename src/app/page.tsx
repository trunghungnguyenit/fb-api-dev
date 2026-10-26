import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb, withPageNames } from "@/lib/db";
import { formatDateTime, postErrorText, statusLabel, truncate } from "@/lib/labels";
import { AppFailure } from "@/lib/errors";
import NewPostButton from "@/app/new-post-button";
import PageHeader from "@/app/page-header";
import StatusPill, { postTone } from "@/app/status-pill";
import ErrorCell from "@/app/posts/error-cell";

export const dynamic = "force-dynamic";

type RecentPostRow = {
  id: string;
  page_id: string;
  message: string;
  status: string;
  publish_phase: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  last_error_code: string | null;
  facebook_deleted_at: string | null;
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
    db.posts.select("id,page_id,message,status,publish_phase,scheduled_at,published_at,last_error_code,facebook_deleted_at,created_at")
      .order("created_at", { ascending: false }).limit(8)
  ]);
  const failure = [pages, posts, scheduled, failed, recent].find((r) => r.error);
  if (failure) throw new AppFailure("DB_ERROR", failure.error);
  let recentPosts;
  try { recentPosts = await withPageNames(db, rows<RecentPostRow>(recent.data)); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }

  return <main className="shell">
    <PageHeader title="Tổng quan" subtitle={`Quản lý bài đăng Facebook · ${user.email}`}><NewPostButton /></PageHeader>
    <section className="grid">
      <div className="panel"><div className="subtle">Fanpage đang kết nối</div><div className="stat">{pages.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Tổng bài viết</div><div className="stat">{posts.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Đang chờ đăng</div><div className="stat">{scheduled.count ?? 0}</div></div>
      <div className="panel"><div className="subtle">Bài đăng lỗi</div><div className="stat">{failed.count ?? 0}</div></div>
    </section>
    <section className="panel">
      <h2>Bài viết gần đây</h2>
      <div className="table-wrap"><table className="cards"><thead><tr><th scope="col">Nội dung</th><th scope="col">Fanpage</th><th scope="col">Trạng thái</th><th scope="col">Thời gian</th><th scope="col" className="col-error">Lỗi</th></tr></thead>
        <tbody>{recentPosts.map((post) => {
          // Same rules as the Bài viết page, so a post reads the same in both places.
          const deleted = Boolean(post.facebook_deleted_at);
          const timeLabel = post.published_at ? "Đã đăng" : post.scheduled_at ? "Lên lịch" : null;
          const timeValue = post.published_at ?? post.scheduled_at;
          return <tr key={post.id}>
            <td data-label="Nội dung">{truncate(post.message, 100) || "(không có chú thích)"}</td>
            <td data-label="Fanpage">{post.facebook_pages?.page_name ?? "—"}</td>
            <td data-label="Trạng thái"><StatusPill tone={postTone(post.status, deleted)}>{statusLabel(post.status, deleted, post.publish_phase)}</StatusPill></td>
            <td className="cell-nowrap" data-label="Thời gian"><div>
              {timeLabel && <div className="subtle cell-meta">{timeLabel}</div>}
              {timeValue ? <div className="mono time-value">{formatDateTime(timeValue)}</div> : <span className="cell-none">—</span>}
            </div></td>
            <td className="col-error" data-label="Lỗi">{post.last_error_code ? <ErrorCell text={postErrorText(post.last_error_code) ?? "—"} /> : <span className="cell-none">—</span>}</td>
          </tr>;
        })}
        {!recentPosts.length && <tr><td colSpan={5}>Chưa có bài viết.</td></tr>}</tbody>
      </table></div>
    </section>
  </main>;
}
