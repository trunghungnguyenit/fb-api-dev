import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { escapeLike, rows, userDb, withPageNames } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { formatDateTime, postErrorText, STATUS_FILTERS, statusLabel, truncate } from "@/lib/labels";
import { repostModes } from "@/lib/repost";
import FacebookFeedView from "./facebook-feed-view";
import PostsTable, { type PostRowView } from "./posts-table";
import { feedIsStaleForUser } from "@/lib/feed-freshness";
import FeedAutoRefresh from "./feed-auto-refresh";
import PostsTabs from "./posts-tabs";
import PageHeader from "@/app/page-header";
import NewPostButton from "@/app/new-post-button";
import Pagination from "./pagination";
import { IconBug, IconSliders } from "@/app/icons";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type Search = { status?: string; page?: string; q?: string; p?: string; batch?: string; source?: string; gone?: string };
type PostRow = {
  id: string;
  page_id: string;
  message: string;
  post_type: string;
  publish_phase: string | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  last_error_code: string | null;
  facebook_post_id: string | null;
  facebook_deleted_at: string | null;
  reposted_from: string | null;
  note: string | null;
};

export default async function PostsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  // Posts read from the Fanpage on Facebook (read-only): a separate list, never mixed into the app's own posts.
  if (sp.source === "facebook") return <FacebookFeedView userId={user.id} search={sp} />;

  // Everything comes from the URL, so validate it: unknown values are ignored, never echoed.
  const status = STATUS_FILTERS.some((s) => s.value === sp.status) ? (sp.status as string) : "";
  const pageFilter = z.string().uuid().safeParse(sp.page).success ? (sp.page as string) : "";
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const batchFilter = z.string().uuid().safeParse(sp.batch).success ? (sp.batch as string) : "";
  const requested = Math.max(1, Math.min(Number.parseInt(sp.p ?? "1", 10) || 1, 100_000));

  const db = userDb(user.id);
  const from = (requested - 1) * PAGE_SIZE;
  let query = db.posts
    .select("id,page_id,message,post_type,publish_phase,status,scheduled_at,published_at,last_error_code,facebook_post_id,facebook_deleted_at,reposted_from,note", { count: "exact" });
  if (status === "deleted") query = query.not("facebook_deleted_at", "is", null);
  else if (status) query = query.eq("status", status);
  if (pageFilter) query = query.eq("page_id", pageFilter);
  if (batchFilter) query = query.eq("import_batch_id", batchFilter);
  if (q) query = query.ilike("message", `%${escapeLike(q)}%`);

  const [list, pagesResult] = await Promise.all([
    query.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1),
    db.pages.select("id,page_name,removed_at").order("page_name")
  ]);
  if (list.error) throw new AppFailure("DB_ERROR", list.error);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);

  let posts;
  try { posts = await withPageNames(db, rows<PostRow>(list.data)); }
  catch (e) { throw new AppFailure("DB_ERROR", e); }

  const total = list.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(requested, totalPages);
  const hasFilter = Boolean(status || pageFilter || q || batchFilter);

  const href = (p: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (pageFilter) params.set("page", pageFilter);
    if (q) params.set("q", q);
    if (batchFilter) params.set("batch", batchFilter);
    if (p > 1) params.set("p", String(p));
    const qs = params.toString();
    return qs ? `/posts?${qs}` : "/posts";
  };

  const views: PostRowView[] = posts.map((post) => {
    const deleted = Boolean(post.facebook_deleted_at);
    return {
      id: post.id,
      text: truncate(post.message, 90) || "(không có chú thích)",
      kind: ({ photo: "1 ảnh", photos: "Nhiều ảnh", video: "Video", reel: "Reels" } as Record<string, string>)[post.post_type] ?? null,
      pageName: post.facebook_pages?.page_name ?? "—",
      status: post.status,
      statusText: statusLabel(post.status, deleted, post.publish_phase),
      deleted,
      hasError: Boolean(post.last_error_code),
      timeLabel: post.published_at ? "Đã đăng" : post.scheduled_at ? "Lên lịch" : null,
      timeValue: post.published_at ? formatDateTime(post.published_at) : post.scheduled_at ? formatDateTime(post.scheduled_at) : "—",
      errorText: postErrorText(post.last_error_code) ?? "—",
      lastErrorCode: post.last_error_code,
      facebookPostId: post.facebook_post_id,
      reposted: Boolean(post.reposted_from),
      note: post.note,
      canRepost: repostModes(post).length > 0,
      // Same rule as the edit page: unpublished posts, and published ones still on Facebook.
      editable: ["draft", "scheduled", "failed"].includes(post.status) || (post.status === "published" && !deleted)
    };
  });

  const stale = await feedIsStaleForUser(user.id);

  // The error quick filter is a real switch: a GET form that sets or clears status=failed and keeps the other filters.
  const failedOn = status === "failed";
  const keep: Record<string, string> = {};
  if (pageFilter) keep.page = pageFilter;
  if (q) keep.q = q;
  if (batchFilter) keep.batch = batchFilter;

  return <main className="shell wide">
    <FeedAutoRefresh stale={stale} />
    <PageHeader title="Bài viết" subtitle="Quản lý nội dung, lịch đăng và lỗi"><NewPostButton /></PageHeader>

    <section className="panel">
      <PostsTabs active="app" />
      {batchFilter && <p className="notice" role="note" style={{ margin: "0 0 14px" }}>
        Đang xem các bài của một lần nhập. <Link href="/posts">Xem tất cả bài viết</Link> · <Link href="/posts/imports">Lịch sử nhập</Link>
      </p>}
      <form method="get" action="/posts" className="filters" role="search">
        {batchFilter && <input type="hidden" name="batch" value={batchFilter} />}
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
            {rows<{ id: string; page_name: string; removed_at: string | null }>(pagesResult.data).map((p) => <option key={p.id} value={p.id}>{p.removed_at ? `${p.page_name} (đã gỡ)` : p.page_name}</option>)}
          </select></div>
        <div className="actions">
          <button className="btn" type="submit"><IconSliders />Lọc</button>
          {hasFilter && <Link className="btn" href="/posts">Xóa bộ lọc</Link>}
        </div>
      </form>

      <div className="neo-toolbar">
        <p className="subtle" aria-live="polite">{total.toLocaleString("vi-VN")} bài{hasFilter ? " phù hợp" : ""} · Trang {current}/{totalPages} · <Link href="/posts/imports">Lịch sử nhập</Link></p>
        <form className="neo-switch-form" method="get" action="/posts">
          {Object.entries(keep).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          {!failedOn && <input type="hidden" name="status" value="failed" />}
          <button className="neo-switch" type="submit" role="switch" aria-checked={failedOn}>
            <IconBug /><span>Lọc trạng thái lỗi</span><span className="track" aria-hidden="true"><span className="knob" /></span>
          </button>
        </form>
      </div>
      <PostsTable posts={views} />

      <Pagination current={current} totalPages={totalPages} href={href} action="/posts" params={{ ...(status ? { status } : {}), ...keep }} />
    </section>
  </main>;
}
