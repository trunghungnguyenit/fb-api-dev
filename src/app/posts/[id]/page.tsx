import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { repostModes } from "@/lib/repost";
import { attemptText, eventLabel, facebookPostUrl, formatDateTime, postErrorText, statusLabel, truncate } from "@/lib/labels";
import FacebookStats from "../facebook-stats";
import PostActions from "../post-actions";
import PostDangerActions from "../post-danger-actions";

export const dynamic = "force-dynamic";

type PostDetail = {
  id: string; page_id: string; message: string; link_url: string | null; status: string;
  scheduled_at: string | null; published_at: string | null; facebook_post_id: string | null;
  last_error_code: string | null; attempt_count: number; edited_at: string | null;
  facebook_deleted_at: string | null; reposted_from: string | null; created_at: string; updated_at: string;
};
type Attempt = {
  id: string; attempt_number: number; outcome: string; error_code: string | null;
  facebook_post_id: string | null; started_at: string; finished_at: string | null;
};
type Relative = { id: string; message: string; status: string; page_id: string; created_at: string; facebook_deleted_at: string | null };
type PostEvent = { id: string; type: string; error_code: string | null; created_at: string };

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = userDb(user.id);

  const [postResult, attemptsResult, eventsResult] = await Promise.all([
    db.posts.select("id,page_id,message,link_url,status,scheduled_at,published_at,facebook_post_id,last_error_code,attempt_count,edited_at,facebook_deleted_at,reposted_from,created_at,updated_at").eq("id", id).maybeSingle(),
    db.attempts.select("id,attempt_number,outcome,error_code,facebook_post_id,started_at,finished_at").eq("post_id", id).order("started_at", { ascending: true }),
    db.events.select("id,type,error_code,created_at").eq("post_id", id).order("created_at", { ascending: false }).limit(50)
  ]);
  if (postResult.error) throw new AppFailure("DB_ERROR", postResult.error);
  const post = one<PostDetail>(postResult.data);
  if (!post) notFound();
  if (attemptsResult.error) throw new AppFailure("DB_ERROR", attemptsResult.error);
  if (eventsResult.error) throw new AppFailure("DB_ERROR", eventsResult.error);

  // Re-post family: the original this post was re-posted from, and the re-posts made from this post.
  const [pageResult, originalResult, copiesResult] = await Promise.all([
    db.pages.select("page_name,is_active").eq("id", post.page_id).maybeSingle(),
    post.reposted_from
      ? db.posts.select("id,message,status,page_id,created_at,facebook_deleted_at").eq("id", post.reposted_from).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.posts.select("id,message,status,page_id,created_at,facebook_deleted_at").eq("reposted_from", id).order("created_at", { ascending: false }).limit(20)
  ]);
  const { data: pageData, error: pageError } = pageResult;
  if (pageError) throw new AppFailure("DB_ERROR", pageError);
  if (originalResult.error) throw new AppFailure("DB_ERROR", originalResult.error);
  if (copiesResult.error) throw new AppFailure("DB_ERROR", copiesResult.error);
  const original = one<Relative>(originalResult.data);
  const copies = rows<Relative>(copiesResult.data);
  const page = one<{ page_name: string; is_active: boolean }>(pageData);

  const attempts = rows<Attempt>(attemptsResult.data);
  const events = rows<PostEvent>(eventsResult.data);
  const deleted = Boolean(post.facebook_deleted_at);
  const published = post.status === "published";
  const editable = ["draft", "scheduled", "failed"].includes(post.status) || (published && !deleted);
  const errorText = postErrorText(post.last_error_code);

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Chi tiết bài viết</h1><div className="subtle">{page?.page_name ?? "Fanpage không còn tồn tại"}</div></div>
      <div className="actions">
        <Link className="btn" href="/posts">Quay lại danh sách</Link>
        <Link className="btn" href={`/posts/new?from=${post.id}`}>Nhân bản</Link>
        {repostModes(post).length > 0 && <Link className="btn" href={`/posts/${post.id}/repost`}>Đăng lại</Link>}
        {editable && <Link className="btn primary" href={`/posts/${post.id}/edit`}>Sửa bài</Link>}
      </div>
    </header>

    <section className="panel" aria-labelledby="info">
      <h2 id="info">Thông tin</h2>
      <dl className="detail-grid">
        <div><dt>Trạng thái</dt><dd><span className="pill">{statusLabel(post.status, deleted)}</span></dd></div>
        <div><dt>Fanpage</dt><dd>{page?.page_name ?? "—"}{page && !page.is_active && <span className="subtle"> (đang tắt)</span>}</dd></div>
        <div><dt>Tạo lúc</dt><dd>{formatDateTime(post.created_at)}</dd></div>
        <div><dt>Giờ lên lịch</dt><dd>{post.scheduled_at ? formatDateTime(post.scheduled_at) : "—"}</dd></div>
        <div><dt>Đã đăng lúc</dt><dd>{post.published_at ? formatDateTime(post.published_at) : "—"}</dd></div>
        <div><dt>Sửa lần cuối trên Facebook</dt><dd>{post.edited_at ? formatDateTime(post.edited_at) : "—"}</dd></div>
        {deleted && post.facebook_deleted_at && <div><dt>Xóa trên Facebook lúc</dt><dd>{formatDateTime(post.facebook_deleted_at)}</dd></div>}
        <div><dt>Số lần thử đăng</dt><dd>{post.attempt_count}</dd></div>
        <div className="wide"><dt>Liên kết</dt><dd>{post.link_url
          ? <a href={post.link_url} target="_blank" rel="noopener noreferrer">{post.link_url}</a> : "—"}</dd></div>
        {post.facebook_post_id && <div className="wide"><dt>ID bài trên Facebook</dt><dd>{post.facebook_post_id}</dd></div>}
      </dl>
      {errorText && <p className="error" role="alert">{errorText}</p>}
    </section>

    {(post.reposted_from || copies.length > 0) && <section className="panel" aria-labelledby="family">
      <h2 id="family">Đăng lại</h2>
      {post.reposted_from && <p>Đăng lại từ bài gốc: {original
        ? <Link href={`/posts/${original.id}`}>{truncate(original.message, 70)}</Link>
        : <span className="subtle">bài gốc đã bị xóa</span>}{original && <span className="subtle"> · {statusLabel(original.status, Boolean(original.facebook_deleted_at))}</span>}</p>}
      {copies.length > 0 && <>
        <p className="subtle">Các lần đăng lại từ bài này ({copies.length}):</p>
        <ul className="plain-list">{copies.map((c) => <li key={c.id}>
          <Link href={`/posts/${c.id}`}>{formatDateTime(c.created_at)}</Link>
          <span className="subtle"> · {statusLabel(c.status, Boolean(c.facebook_deleted_at))}</span>
        </li>)}</ul>
      </>}
    </section>}

    <section className="panel" aria-labelledby="content">
      <h2 id="content">Nội dung</h2>
      <p className="post-body">{post.message}</p>
      <p className="subtle">{Array.from(post.message).length.toLocaleString("vi-VN")} ký tự</p>
    </section>

    {published && post.facebook_post_id && (deleted
      ? <section className="panel"><p className="error" role="alert">Bài này đã bị xóa trên Facebook.</p></section>
      : <section className="panel" aria-labelledby="live">
          <h2 id="live">Trên Facebook</h2>
          <FacebookStats postId={post.id} fallbackUrl={facebookPostUrl(post.facebook_post_id)} markedDeleted={deleted} />
        </section>)}

    <section className="panel" aria-labelledby="actions">
      <h2 id="actions">Thao tác</h2>
      <PostActions id={post.id} status={post.status} lastErrorCode={post.last_error_code} />
      <div style={{ marginTop: 16 }}>
        <PostDangerActions id={post.id} status={post.status} lastErrorCode={post.last_error_code} deletedOnFacebook={deleted} />
      </div>
    </section>

    <section className="panel" aria-labelledby="attempts">
      <h2 id="attempts">Lịch sử đăng</h2>
      {attempts.length === 0 ? <p className="subtle">Chưa có lần đăng nào.</p> : <div className="table-wrap"><table>
        <thead><tr><th scope="col">Lần</th><th scope="col">Bắt đầu</th><th scope="col">Kết thúc</th><th scope="col">Kết quả</th><th scope="col">ID bài trên Facebook</th></tr></thead>
        <tbody>{attempts.map((a) => <tr key={a.id}>
          <td>{a.attempt_number}</td><td>{formatDateTime(a.started_at)}</td>
          <td>{a.finished_at ? formatDateTime(a.finished_at) : "—"}</td><td>{attemptText(a.outcome, a.error_code)}</td><td>{a.facebook_post_id ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    {events.length > 0 && <section className="panel" aria-labelledby="events">
      <h2 id="events">Nhật ký trên Facebook</h2>
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Thời gian</th><th scope="col">Sự kiện</th></tr></thead>
        <tbody>{events.map((e) => <tr key={e.id}>
          <td>{formatDateTime(e.created_at)}</td>
          <td>{eventLabel(e.type)}{e.error_code && <div className="subtle">{postErrorText(e.error_code)}</div>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </main>;
}
