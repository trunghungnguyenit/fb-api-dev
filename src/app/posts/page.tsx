import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { escapeLike, rows, userDb, withPageNames } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { formatDateTime, postErrorText, STATUS_FILTERS, statusLabel, truncate } from "@/lib/labels";
import { repostModes } from "@/lib/repost";
import PostsTable, { type PostRowView } from "./posts-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type Search = { status?: string; page?: string; q?: string; p?: string };
type PostRow = {
  id: string;
  page_id: string;
  message: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  last_error_code: string | null;
  facebook_post_id: string | null;
  facebook_deleted_at: string | null;
  reposted_from: string | null;
};

export default async function PostsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const sp = await searchParams;

  // Everything comes from the URL, so validate it: unknown values are ignored, never echoed.
  const status = STATUS_FILTERS.some((s) => s.value === sp.status) ? (sp.status as string) : "";
  const pageFilter = z.string().uuid().safeParse(sp.page).success ? (sp.page as string) : "";
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const requested = Math.max(1, Math.min(Number.parseInt(sp.p ?? "1", 10) || 1, 100_000));

  const db = userDb(user.id);
  const from = (requested - 1) * PAGE_SIZE;
  let query = db.posts
    .select("id,page_id,message,status,scheduled_at,published_at,last_error_code,facebook_post_id,facebook_deleted_at,reposted_from", { count: "exact" });
  if (status === "deleted") query = query.not("facebook_deleted_at", "is", null);
  else if (status) query = query.eq("status", status);
  if (pageFilter) query = query.eq("page_id", pageFilter);
  if (q) query = query.ilike("message", `%${escapeLike(q)}%`);

  const [list, pagesResult] = await Promise.all([
    query.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1),
    db.pages.select("id,page_name").order("page_name")
  ]);
  if (list.error) throw new AppFailure("DB_ERROR", list.error);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);

  let posts;
  try { posts = await withPageNames(db, rows<PostRow>(list.data)); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }

  const total = list.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(requested, totalPages);
  const hasFilter = Boolean(status || pageFilter || q);

  const href = (p: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (pageFilter) params.set("page", pageFilter);
    if (q) params.set("q", q);
    if (p > 1) params.set("p", String(p));
    const qs = params.toString();
    return qs ? `/posts?${qs}` : "/posts";
  };

  const views: PostRowView[] = posts.map((post) => {
    const deleted = Boolean(post.facebook_deleted_at);
    return {
      id: post.id,
      text: truncate(post.message, 90),
      pageName: post.facebook_pages?.page_name ?? "—",
      status: post.status,
      statusText: statusLabel(post.status, deleted),
      timeLabel: post.published_at ? "Đã đăng" : post.scheduled_at ? "Lên lịch" : null,
      timeValue: post.published_at ? formatDateTime(post.published_at) : post.scheduled_at ? formatDateTime(post.scheduled_at) : "—",
      errorText: postErrorText(post.last_error_code) ?? "—",
      lastErrorCode: post.last_error_code,
      facebookPostId: post.facebook_post_id,
      reposted: Boolean(post.reposted_from),
      canRepost: repostModes(post).length > 0,
      // Same rule as the edit page: unpublished posts, and published ones still on Facebook.
      editable: ["draft", "scheduled", "failed"].includes(post.status) || (post.status === "published" && !deleted)
    };
  });

  return <main className="shell">
    <header className="header"><div><h1 className="brand">Bài viết</h1><div className="subtle">Quản lý nội dung, lịch đăng và lỗi</div></div>
      <div className="actions"><Link className="btn" href="/">Trang chủ</Link><Link className="btn primary" href="/posts/new">+ Soạn bài</Link></div>
    </header>

    <section className="panel">
      <form method="get" action="/posts" className="filters" role="search">
        <div className="field"><label htmlFor="q">Tìm theo nội dung</label>
          <input id="q" name="q" type="search" defaultValue={q} maxLength={100} placeholder="Nhập từ khóa…" /></div>
        <div className="field"><label htmlFor="status">Trạng thái</label>
          <select id="status" name="status" defaultValue={status}>
            <option value="">Tất cả</option>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor="page">Fanpage</label>
          <select id="page" name="page" defaultValue={pageFilter}>
            <option value="">Tất cả</option>
            {rows<{ id: string; page_name: string }>(pagesResult.data).map((p) => <option key={p.id} value={p.id}>{p.page_name}</option>)}
          </select></div>
        <div className="actions">
          <button className="btn primary" type="submit">Lọc</button>
          {hasFilter && <Link className="btn" href="/posts">Xóa bộ lọc</Link>}
        </div>
      </form>

      <p className="subtle" aria-live="polite">{total.toLocaleString("vi-VN")} bài{hasFilter ? " phù hợp" : ""} · Trang {current}/{totalPages}</p>
      <PostsTable posts={views} />

      {totalPages > 1 && <nav className="pager" aria-label="Phân trang">
        {current > 1 ? <Link className="btn" href={href(current - 1)}>← Trước</Link> : <span />}
        <span className="subtle">Trang {current} / {totalPages}</span>
        {current < totalPages ? <Link className="btn" href={href(current + 1)}>Sau →</Link> : <span />}
      </nav>}
    </section>
  </main>;
}
