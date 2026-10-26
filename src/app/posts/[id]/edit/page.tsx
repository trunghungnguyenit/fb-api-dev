import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { clientLimits } from "@/lib/media/limits";
import { mediaLimits } from "@/lib/media/config";
import { mediaOfPosts } from "@/lib/media/service";
import { signedUrls } from "@/lib/media/storage";
import PostEditor, { type EditorImage } from "./post-editor";

export const dynamic = "force-dynamic";

type EditablePost = {
  id: string; page_id: string; message: string; link_url: string | null; post_type: string | null; status: string;
  scheduled_at: string | null; last_error_code: string | null; facebook_deleted_at: string | null; note: string | null;
};

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = userDb(user.id);

  const [postResult, pagesResult] = await Promise.all([
    db.posts.select("id,page_id,message,link_url,post_type,status,scheduled_at,last_error_code,facebook_deleted_at,note").eq("id", id).maybeSingle(),
    db.pages.select("id,page_name,is_active,removed_at").order("page_name")
  ]);
  if (postResult.error) throw new AppFailure("DB_ERROR", postResult.error);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);
  const post = one<EditablePost>(postResult.data);
  if (!post) notFound();

  const published = post.status === "published";
  const canEdit = ["draft", "scheduled", "failed"].includes(post.status) || (published && !post.facebook_deleted_at);
  if (!canEdit) {
    return <main className="shell"><section className="panel">
      <h1 className="brand">Không thể sửa bài</h1>
      <p className="subtle">
        {post.facebook_deleted_at ? "Bài này đã bị xóa trên Facebook." : post.status === "publishing" ? "Bài đang được đăng, hãy thử lại sau ít giây." : "Bài ở trạng thái hiện tại không thể sửa."}
      </p>
      <div className="actions"><Link className="btn primary" href={`/posts/${post.id}`}>Quay lại chi tiết bài</Link></div>
    </section></main>;
  }

  // The post's images, with short-lived links so they can be shown (the bucket is private).
  const files = (await mediaOfPosts(db, [post.id])).get(post.id) ?? [];
  const live = files.filter((f) => f.state === "uploaded");
  const urls = live.length ? await signedUrls(live.map((f) => f.storage_path), 60 * 60).catch(() => new Map<string, string>()) : new Map<string, string>();
  const images: EditorImage[] = files.map((f) => ({
    id: f.id, kind: f.kind, url: urls.get(f.storage_path) ?? null, name: f.file_name ?? "tệp", size: f.size_bytes, purged: f.state !== "uploaded"
  }));

  // Only active Pages can be chosen, plus the post's current one so the form can show it.
  const pages = rows<{ id: string; page_name: string; is_active: boolean; removed_at: string | null }>(pagesResult.data)
    .filter((p) => p.is_active || p.id === post.page_id);

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Sửa bài viết</h1><div className="subtle">{published ? "Bài đã đăng: chỉ sửa được nội dung chữ" : "Bài chưa đăng: sửa được mọi thông tin"}</div></div>
      <Link className="btn" href={`/posts/${post.id}`}>Hủy, quay lại</Link>
    </header>
    <section className="panel">
      <PostEditor
        id={post.id}
        mode={published ? "published" : "unpublished"}
        status={post.status}
        ambiguous={post.last_error_code === "AMBIGUOUS"}
        postType={post.post_type ?? "text"}
        initial={{ pageId: post.page_id, message: post.message, linkUrl: post.link_url ?? "", scheduledAt: post.scheduled_at, note: post.note ?? "" }}
        images={images}
        limits={clientLimits(mediaLimits)}
        pages={pages.map((p) => ({ id: p.id, page_name: p.removed_at ? `${p.page_name} (đã gỡ)` : p.is_active ? p.page_name : `${p.page_name} (đang tắt)`, disabled: !p.is_active }))}
      />
    </section>
  </main>;
}
