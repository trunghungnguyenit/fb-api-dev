import Link from "next/link";
import { feedKindLabel, formatDateTime, truncate } from "@/lib/labels";
import { TOP_SORTS, type TopPostsResult, type TopSort } from "@/lib/top-posts";

const num = (value: number) => value.toLocaleString("vi-VN");

/** The Fanpage's best posts of the last 7 days (from the stored copy, so it shows even when Facebook cannot be asked). */
export default function TopPosts({ result, hrefFor }: { result: TopPostsResult; hrefFor: (sort: TopSort) => string }) {
  const { posts, sort } = result;
  return <section className="panel" aria-labelledby="top-posts">
    <h2 id="top-posts">Bài nổi bật · {result.windowDays} ngày gần nhất</h2>
    <nav className="top-sorts" aria-label="Xếp theo">
      {TOP_SORTS.map((s) => <Link key={s.value} className="btn small" href={hrefFor(s.value)} aria-current={s.value === sort ? "true" : undefined}>{s.label}</Link>)}
    </nav>
    {posts.length === 0
      ? <p className="subtle">Chưa có bài nào có {sort === "total" ? "tương tác" : TOP_SORTS.find((s) => s.value === sort)?.label.toLowerCase()} trong {result.windowDays} ngày gần nhất.</p>
      : <div className="table-wrap"><table className="cards top-table">
          <thead><tr>
            <th scope="col">#</th><th scope="col" className="col-content">Bài</th><th scope="col">Đăng lúc</th>
            <th scope="col">Cảm xúc</th><th scope="col">Bình luận</th><th scope="col">Chia sẻ</th><th scope="col">Tổng</th>
          </tr></thead>
          <tbody>{posts.map((post, i) => <tr key={post.id}>
            <td data-label="Hạng">{i + 1}</td>
            <td className="col-content" data-label="Bài">
              <Link href={post.appPostId ? `/posts/${post.appPostId}` : `/posts/facebook/${post.id}`}>{truncate(post.message, 90) || "(không có chú thích)"}</Link>
              <span className="badge">{feedKindLabel(post.statusType, 0)}</span>
              {post.appPostId && <span className="badge badge-app">Đăng từ ứng dụng</span>}
            </td>
            <td data-label="Đăng lúc" className="cell-nowrap">{formatDateTime(post.createdTime)}</td>
            <td data-label="Cảm xúc" className={sort === "reactions" ? "top-key" : undefined}>{num(post.reactions)}</td>
            <td data-label="Bình luận" className={sort === "comments" ? "top-key" : undefined}>{num(post.comments)}</td>
            <td data-label="Chia sẻ" className={sort === "shares" ? "top-key" : undefined}>{num(post.shares)}</td>
            <td data-label="Tổng" className={sort === "total" ? "top-key" : undefined}>{num(post.total)}</td>
          </tr>)}</tbody>
        </table></div>}
    <p className="subtle form-hint">
      Lấy từ bản sao đã đồng bộ{result.syncedAt ? ` (đọc lúc ${formatDateTime(result.syncedAt)})` : ""}, không gọi thêm Facebook. Gồm cả bài do ứng dụng đăng và bài đăng trực tiếp trên Facebook; bài đã bị xóa không được tính.
    </p>
  </section>;
}
