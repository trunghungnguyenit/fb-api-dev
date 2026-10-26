import Link from "next/link";
import { z } from "zod";
import { escapeLike, rows, userDb } from "@/lib/db";
import { AppFailure, messageFor } from "@/lib/errors";
import { feedKindLabel, formatDateTime, truncate } from "@/lib/labels";
import { feedIsStale } from "@/lib/feed-freshness";
import { SYNC_INTERVAL_MS } from "@/lib/meta/feed-posts";
import FeedAutoRefresh from "./feed-auto-refresh";
import PostsTabs from "./posts-tabs";
import PageHeader from "@/app/page-header";
import NewPostButton from "@/app/new-post-button";
import FilterBar from "./filter-bar";
import Pagination from "./pagination";
import { IconSliders, StatusIcon } from "@/app/icons";

const PAGE_SIZE = 25;
/** "Xem thêm" stacks pages in one list: at most 1000 rows, which is also what the database answers in one request. */
const MORE_MAX_PAGES = 40;

type FeedRow = {
  id: string; page_id: string; message: string; permalink_url: string | null; status_type: string | null; created_time: string;
  media: unknown; reactions_count: number | null; comments_count: number | null; comments_seen_count: number | null; shares_count: number | null; missing_since: string | null; absent_checks: number; post_id: string | null;
};
type PageRow = { id: string; page_name: string; removed_at: string | null; feed_synced_at: string | null; feed_sync_error: string | null; is_active: boolean };

const mediaCount = (media: unknown) => (Array.isArray(media) ? media.length : 0);
const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("vi-VN"));
/** Comments that arrived since the user last opened the post (nothing when there is no mark to compare with). */
const unseen = (post: { comments_count: number | null; comments_seen_count: number | null }) =>
  post.comments_count !== null && post.comments_seen_count !== null ? Math.max(0, post.comments_count - post.comments_seen_count) : 0;

/**
 * Every post of the Fanpages as Facebook shows them. A post this app published carries the label "Đăng từ ứng dụng" and
 * opens in the app, which has the tools to manage it; a post made directly on Facebook is for looking at only.
 */
export default async function FacebookFeedView({ userId, search }: { userId: string; search: { page?: string; q?: string; p?: string; gone?: string; more?: string } }) {
  const pageFilter = z.string().uuid().safeParse(search.page).success ? (search.page as string) : "";
  const q = (typeof search.q === "string" ? search.q : "").trim().slice(0, 100);
  const onlyGone = search.gone === "1";
  const requested = Math.max(1, Math.min(Number.parseInt(search.p ?? "1", 10) || 1, search.more === "1" ? MORE_MAX_PAGES : 100_000));
  // "Xem thêm" (phones) shows every page up to the requested one in one list; the numbered pages show one page.
  const more = search.more === "1";
  const from = more ? 0 : (requested - 1) * PAGE_SIZE;

  const db = userDb(userId);
  let query = db.feed
    .select("id,page_id,message,permalink_url,status_type,created_time,media,reactions_count,comments_count,comments_seen_count,shares_count,missing_since,absent_checks,post_id", { count: "exact" });
  if (pageFilter) query = query.eq("page_id", pageFilter);
  if (q) query = query.ilike("message", `%${escapeLike(q)}%`);
  if (onlyGone) query = query.not("missing_since", "is", null);

  const [list, pagesResult] = await Promise.all([
    query.order("created_time", { ascending: false }).range(from, requested * PAGE_SIZE - 1),
    db.pages.select("id,page_name,removed_at,feed_synced_at,feed_sync_error,is_active").order("page_name")
  ]);
  if (list.error) throw new AppFailure("DB_ERROR", list.error);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);

  const pages = rows<PageRow>(pagesResult.data);
  const names = new Map(pages.map((p) => [p.id, p.removed_at ? `${p.page_name} (đã gỡ)` : p.page_name]));
  const posts = rows<FeedRow>(list.data);
  const total = list.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(requested, totalPages);
  const hasFilter = Boolean(pageFilter || q || onlyGone);
  const failing = pages.filter((p) => p.is_active && !p.removed_at && p.feed_sync_error);
  const neverSynced = pages.filter((p) => p.is_active && !p.removed_at && !p.feed_synced_at && !p.feed_sync_error);

  const href = (p: number, withMore = false) => {
    const params = new URLSearchParams({ source: "facebook" });
    if (pageFilter) params.set("page", pageFilter);
    if (q) params.set("q", q);
    if (onlyGone) params.set("gone", "1");
    if (p > 1) params.set("p", String(p));
    if (withMore && p > 1) params.set("more", "1");
    return `/posts?${params}`;
  };

  const keep: Record<string, string> = { source: "facebook" };
  if (pageFilter) keep.page = pageFilter;
  if (q) keep.q = q;
  if (onlyGone) keep.gone = "1";

  return <main className="shell wide">
    <FeedAutoRefresh stale={feedIsStale(pages)} />
    <PageHeader title="Bài viết" subtitle="Bài đăng trên Fanpage của bạn, đọc từ Facebook"><NewPostButton /></PageHeader>

    <section className="panel">
      <PostsTabs active="facebook" />
      <p className="notice" role="note">
        Các bài trên Fanpage của bạn như Facebook đang hiển thị trong khoảng 7 ngày gần nhất, tự cập nhật khoảng {Math.round(SYNC_INTERVAL_MS / 60000)} phút một lần
        (và ngay khi bạn mở trang hoặc bấm “Tải lại từ Facebook”). Bài có nhãn “Đăng từ ứng dụng” được quản lý ở tab “Bài của ứng dụng”; bài đăng trực tiếp trên Facebook chỉ để xem.
      </p>
      {failing.map((p) => <p key={p.id} className="error" role="alert">
        Chưa đọc được bài của “{p.page_name}”: {messageFor(p.feed_sync_error)} <Link href="/pages">Xem Fanpage</Link>
      </p>)}
      {neverSynced.length > 0 && <p className="subtle">{neverSynced.length} Fanpage chưa được đồng bộ lần nào; hệ thống sẽ đọc trong ít phút.</p>}

      <FilterBar active={Number(Boolean(pageFilter)) + Number(onlyGone)}>
      <form method="get" action="/posts" className="filters" role="search">
        <input type="hidden" name="source" value="facebook" />
        <div className="field field-search"><label htmlFor="q">Tìm theo nội dung</label>
          <input id="q" name="q" type="search" defaultValue={q} maxLength={100} placeholder="Nhập từ khóa…" /></div>
        <div className="field"><label htmlFor="page">Fanpage</label>
          <select id="page" name="page" defaultValue={pageFilter}>
            <option value="">Tất cả</option>
            {pages.map((p) => <option key={p.id} value={p.id}>{names.get(p.id)}</option>)}
          </select></div>
        <div className="field"><label className="choice-inline" htmlFor="gone"><input id="gone" name="gone" type="checkbox" value="1" defaultChecked={onlyGone} /> Chỉ bài đã xóa trên Facebook</label></div>
        <div className="actions">
          <button className="btn" type="submit"><IconSliders />Lọc</button>
          {hasFilter && <Link className="btn" href="/posts?source=facebook">Xóa bộ lọc</Link>}
        </div>
      </form>
      </FilterBar>

      <p className="subtle" aria-live="polite">{total.toLocaleString("vi-VN")} bài{hasFilter ? " phù hợp" : ""} · Trang {current}/{totalPages}</p>
      <div className="table-wrap"><table className="cards">
        <thead><tr>
          <th scope="col" className="col-content">Nội dung</th><th scope="col">Fanpage</th><th scope="col">Đăng lúc</th>
          <th scope="col">Tương tác</th><th scope="col">Trạng thái</th><th scope="col" className="col-actions">Xem</th>
        </tr></thead>
        <tbody>
          {posts.map((post) => <tr key={post.id}>
            <td className="col-content" data-label="Nội dung">
              <Link href={post.post_id ? `/posts/${post.post_id}` : `/posts/facebook/${post.id}`}>{truncate(post.message, 90) || "(không có chú thích)"}</Link>
              <span className="badge">{feedKindLabel(post.status_type, mediaCount(post.media))}</span>
              {post.post_id && <span className="badge badge-app">Đăng từ ứng dụng</span>}
            </td>
            <td data-label="Fanpage" className="cell-nowrap">{names.get(post.page_id) ?? "—"}</td>
            <td data-label="Đăng lúc" className="cell-nowrap">{formatDateTime(post.created_time)}</td>
            <td data-label="Tương tác" className="cell-nowrap" title="Cảm xúc · bình luận · lượt chia sẻ">{num(post.reactions_count)} · {num(post.comments_count)} · {num(post.shares_count)}
              {unseen(post) > 0 && <span className="badge badge-new" title="Bình luận mới từ lần bạn mở bài này">{unseen(post).toLocaleString("vi-VN")} mới</span>}</td>
            <td data-label="Trạng thái">{post.missing_since
              ? <span className="pill pill-bad"><StatusIcon tone="bad" />Đã xóa trên Facebook</span>
              : post.absent_checks > 0
                ? <span className="pill pill-warn" title="Lần đọc gần nhất không thấy bài này; cần đọc thêm một lần nữa để chắc chắn. Bấm “Tải lại từ Facebook” để xác nhận."><StatusIcon tone="warn" />Có thể đã xóa, đang xác nhận</span>
                : <span className="pill pill-ok"><StatusIcon tone="ok" />Còn trên Facebook</span>}</td>
            <td data-label="Xem" className="col-actions">{post.permalink_url
              ? <a href={post.permalink_url} target="_blank" rel="noopener noreferrer">Mở trên Facebook</a> : <span className="subtle">—</span>}</td>
          </tr>)}
          {posts.length === 0 && <tr><td colSpan={6}>{hasFilter
            ? "Không có bài nào phù hợp bộ lọc."
            : "Chưa có bài nào từ Facebook. Khi một Fanpage được đồng bộ, các bài đăng trong 7 ngày gần nhất (không do ứng dụng đăng) sẽ hiện ở đây."}</td></tr>}
        </tbody>
      </table></div>

      <Pagination current={current} totalPages={totalPages} href={href} action="/posts" params={keep}
        more={{ href: href(current + 1, true), remaining: Math.max(0, total - current * PAGE_SIZE), total }} />
    </section>
  </main>;
}
