import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { isLiveOnFacebook, REPOST_LIMIT_PER_DAY, repostModes } from "@/lib/repost";
import { statusLabel } from "@/lib/labels";
import { mediaOfPosts } from "@/lib/media/service";
import RepostForm from "./repost-form";

export const dynamic = "force-dynamic";

type Source = {
  id: string; page_id: string; message: string; link_url: string | null; post_type: string | null; status: string;
  facebook_post_id: string | null; facebook_deleted_at: string | null; last_error_code: string | null;
};

export default async function RepostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = userDb(user.id);

  const [postResult, pagesResult] = await Promise.all([
    db.posts.select("id,page_id,message,link_url,post_type,status,facebook_post_id,facebook_deleted_at,last_error_code").eq("id", id).maybeSingle(),
    db.pages.select("id,page_name").eq("is_active", true).order("page_name")
  ]);
  if (postResult.error) throw new AppFailure("DB_ERROR", postResult.error);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);
  const post = one<Source>(postResult.data);
  if (!post) notFound();

  const images = (await mediaOfPosts(db, [post.id])).get(post.id) ?? [];
  const modes = repostModes(post);
  const pages = rows<{ id: string; page_name: string }>(pagesResult.data);

  if (!modes.length || !pages.length) {
    return <main className="shell"><section className="panel">
      <h1 className="brand">Không thể đăng lại</h1>
      <p className="subtle">
        {!pages.length ? "Bạn chưa có Fanpage nào đang kết nối." : `Bài đang ở trạng thái “${statusLabel(post.status, Boolean(post.facebook_deleted_at))}” nên chưa thể đăng lại.`}
      </p>
      <div className="actions">
        <Link className="btn primary" href={`/posts/${post.id}`}>Quay lại chi tiết bài</Link>
        {!pages.length && <Link className="btn" href="/pages">Kết nối Facebook</Link>}
      </div>
    </section></main>;
  }

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Đăng lại bài viết</h1><div className="subtle">Xem lại nội dung rồi chọn cách và thời điểm đăng. Tối đa {REPOST_LIMIT_PER_DAY} lần/24 giờ cho mỗi Fanpage.</div></div>
      <Link className="btn" href={`/posts/${post.id}`}>Hủy, quay lại</Link>
    </header>
    <section className="panel">
      <RepostForm
        id={post.id}
        modes={modes}
        live={isLiveOnFacebook(post)}
        ambiguous={post.last_error_code === "AMBIGUOUS"}
        sourcePageId={post.page_id}
        postType={post.post_type ?? "text"}
        initial={{ message: post.message, linkUrl: post.link_url ?? "" }}
        pages={pages}
        imageCount={images.length}
      />
    </section>
  </main>;
}
