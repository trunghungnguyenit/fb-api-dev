import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { feedKindLabel, formatDateTime } from "@/lib/labels";
import CommentsPanel from "../../comments-panel";

export const dynamic = "force-dynamic";

type FeedPost = {
  id: string; page_id: string; message: string; permalink_url: string | null; status_type: string | null; created_time: string;
  media: { type?: string; url?: string | null }[] | null; reactions_count: number | null; comments_count: number | null; shares_count: number | null;
  first_seen_at: string; last_seen_at: string; missing_since: string | null; post_id: string | null;
};

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("vi-VN"));

/** A post read from Facebook: everything here is for looking at. The app never edits, deletes or re-posts it. */
export default async function FacebookPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = userDb(user.id);

  const { data, error } = await db.feed
    .select("id,page_id,message,permalink_url,status_type,created_time,media,reactions_count,comments_count,shares_count,first_seen_at,last_seen_at,missing_since,post_id")
    .eq("id", id).maybeSingle();
  if (error) throw new AppFailure("DB_ERROR", error);
  const post = one<FeedPost>(data);
  if (!post) notFound();
  // A post the app published itself is managed on its own page.
  if (post.post_id) redirect(`/posts/${post.post_id}`);

  const { data: pageData, error: pageError } = await db.pages.select("page_name,removed_at").eq("id", post.page_id).maybeSingle();
  if (pageError) throw new AppFailure("DB_ERROR", pageError);
  const page = one<{ page_name: string; removed_at: string | null }>(pageData);
  const media = Array.isArray(post.media) ? post.media : [];

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Bài từ Facebook</h1><div className="subtle">{page?.page_name ?? "Fanpage không còn tồn tại"}{page?.removed_at ? " (đã gỡ khỏi ứng dụng)" : ""}</div></div>
      <div className="actions"><Link className="btn" href="/posts?source=facebook">Quay lại danh sách</Link>
        {post.permalink_url && <a className="btn primary" href={post.permalink_url} target="_blank" rel="noopener noreferrer">Mở trên Facebook</a>}</div>
    </header>

    <p className="notice" role="note">Bài này được đăng trực tiếp trên Facebook nên ứng dụng chỉ hiển thị, không sửa, xóa hay đăng lại (bạn vẫn có thể xem và kiểm duyệt bình luận bên dưới).</p>
    {post.missing_since && <p className="error" role="alert">Bài không còn xuất hiện trên Fanpage từ {formatDateTime(post.missing_since)}; có thể đã bị xóa hoặc ẩn.</p>}

    <section className="panel" aria-labelledby="info">
      <h2 id="info">Thông tin</h2>
      <dl className="detail-grid">
        <div><dt>Loại</dt><dd>{feedKindLabel(post.status_type, media.length)}</dd></div>
        <div><dt>Đăng lúc</dt><dd>{formatDateTime(post.created_time)}</dd></div>
        <div><dt>Cảm xúc</dt><dd>{num(post.reactions_count)}</dd></div>
        <div><dt>Bình luận</dt><dd>{num(post.comments_count)}</dd></div>
        <div><dt>Lượt chia sẻ</dt><dd>{num(post.shares_count)}</dd></div>
        <div><dt>Thấy lần đầu</dt><dd>{formatDateTime(post.first_seen_at)}</dd></div>
        <div><dt>Cập nhật lần cuối</dt><dd>{formatDateTime(post.last_seen_at)}</dd></div>
      </dl>
    </section>

    {!post.missing_since && !page?.removed_at && <section className="panel" aria-labelledby="comments">
      <h2 id="comments">Bình luận</h2>
      <CommentsPanel kind="feed" postId={post.id} />
    </section>}

    <section className="panel" aria-labelledby="content">
      <h2 id="content">Nội dung</h2>
      {post.message ? <p className="post-body">{post.message}</p> : <p className="subtle">Bài không có chú thích.</p>}
      {media.length > 0 && <>
        <h3>Đính kèm ({media.length})</h3>
        <ul className="plain-list">{media.map((m, i) => <li key={i}>
          {m.type ?? "tệp"}{m.url && <> · <a href={m.url} target="_blank" rel="noopener noreferrer">mở liên kết</a></>}
        </li>)}</ul>
      </>}
    </section>
  </main>;
}
