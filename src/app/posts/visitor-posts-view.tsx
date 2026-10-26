import Link from "next/link";
import NewPostButton from "@/app/new-post-button";
import PageHeader from "@/app/page-header";
import { loadVisitorPosts } from "@/lib/guest-content";
import { formatDateTime } from "@/lib/labels";
import { CURSOR_PATTERN } from "@/lib/meta/guest";
import CommentsPanel from "./comments-panel";
import { CursorNav, GuestPagePicker, GuestProblemBox, guestProblem, pickGuestPage } from "./guest-shared";
import PostsTabs from "./posts-tabs";

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("vi-VN"));

/**
 * Posts that visitors wrote on a Fanpage's wall, read from Facebook each time the tab is opened. Nothing is stored. The Page can
 * read the comments under them and answer; the post itself is for looking at (and opening on Facebook).
 */
export default async function VisitorPostsView({ userId, search }: { userId: string; search: { page?: string; after?: string } }) {
  const { pages, selected } = await pickGuestPage(userId, search.page);
  const after = typeof search.after === "string" && CURSOR_PATTERN.test(search.after) ? search.after : undefined;

  let result: Awaited<ReturnType<typeof loadVisitorPosts>> | null = null;
  let problem = null;
  if (selected) {
    try { result = await loadVisitorPosts(userId, selected.id, after); }
    catch (e) { problem = guestProblem(e); }
  }

  return <main className="shell wide">
    <PageHeader title="Bài viết" subtitle="Bài khách viết trên tường Fanpage, đọc từ Facebook"><NewPostButton /></PageHeader>
    <section className="panel">
      <PostsTabs active="visitor" page={selected?.id} />
      <p className="notice" role="note">
        Bài của khách được đọc trực tiếp từ Facebook mỗi lần bạn mở tab này và <strong>không được lưu</strong> trong ứng dụng. Bạn xem được bài,
        đọc và trả lời bình luận dưới bài; muốn xóa hoặc ẩn chính bài của khách, hãy mở bài trên Facebook.
      </p>
      {!selected
        ? <p>Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> để xem bài của khách.</p>
        : <>
            <GuestPagePicker source="visitor" pages={pages} selected={selected.id} />
            {problem && <GuestProblemBox problem={problem} />}
            {result && (result.items.length === 0
              ? <p className="subtle">{after ? "Không còn bài nào nữa." : `Chưa có bài nào của khách trên tường “${selected.page_name}”.`}</p>
              : <ul className="comment-list">
                  {result.items.map((post) => <li key={post.id} className="comment">
                    <div className="comment-head">
                      <strong>{post.author ?? "Người dùng Facebook"}</strong>
                      {post.createdTime && <span className="subtle"> · {formatDateTime(post.createdTime)}</span>}
                    </div>
                    {post.message ? <p className="comment-body">{post.message}</p> : <p className="subtle">(không có chữ)</p>}
                    <div className="comment-actions">
                      <span className="subtle" title="Cảm xúc · bình luận">{num(post.reactions)} cảm xúc · {num(post.comments)} bình luận</span>
                      {post.permalinkUrl && <a href={post.permalinkUrl} target="_blank" rel="noopener noreferrer">Mở trên Facebook</a>}
                    </div>
                    <details className="guest-comments">
                      <summary>Bình luận dưới bài</summary>
                      <CommentsPanel kind="visitor" postId={selected.id} facebookPostId={post.id} />
                    </details>
                  </li>)}
                </ul>)}
            {result && <CursorNav source="visitor" page={selected.id} after={after} next={result.next} />}
          </>}
    </section>
  </main>;
}
