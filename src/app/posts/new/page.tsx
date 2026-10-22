import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import { clientLimits } from "@/lib/media/limits";
import { mediaLimits } from "@/lib/media/config";
import { mediaOfPosts } from "@/lib/media/service";
import { signedUrls } from "@/lib/media/storage";
import PostComposer, { type InitialImage } from "./post-composer";

export const dynamic = "force-dynamic";

export default async function NewPostPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { from } = await searchParams;
  const db = userDb(user.id);
  const { data, error } = await db.pages.select("id,page_name").eq("is_active", true).order("page_name");
  if (error) throw new AppFailure("DB_ERROR", error);
  const pages = rows<{ id: string; page_name: string }>(data);

  // "Nhân bản": start from an existing post's content (a post of this user only; anything else is ignored).
  let initial: { pageId: string; message: string; linkUrl: string; images?: InitialImage[]; imagesNotice?: string } | undefined;
  if (from && z.string().uuid().safeParse(from).success) {
    const { data: source, error: sourceError } = await db.posts.select("page_id,message,link_url").eq("id", from).maybeSingle();
    if (sourceError) throw new AppFailure("DB_ERROR", sourceError);
    const post = one<{ page_id: string; message: string; link_url: string | null }>(source);
    if (post) initial = {
      // Keep the original Page when it is still connected, otherwise let the user pick one.
      pageId: pages.some((p) => p.id === post.page_id) ? post.page_id : (pages[0]?.id ?? ""),
      message: post.message, linkUrl: post.link_url ?? ""
    };
    if (post && initial) {
      // The source's images: the new post gets copies of the entries (the stored files are shared).
      const files = (await mediaOfPosts(db, [from])).get(from) ?? [];
      const usable = files.filter((f) => f.state === "uploaded");
      if (files.length > usable.length) initial.imagesNotice = "Một số tệp ảnh/video của bài gốc đã được dọn khỏi hệ thống nên không có trong bản nhân bản. Hãy tải lên lại nếu cần.";
      if (usable.length) {
        const urls = await signedUrls(usable.map((f) => f.storage_path), 60 * 60).catch(() => new Map<string, string>());
        initial.images = usable.filter((f) => urls.has(f.storage_path))
          .map((f) => ({ id: f.id, kind: f.kind, url: urls.get(f.storage_path) as string, name: f.file_name ?? "tệp", size: f.size_bytes }));
      }
    }
  }

  return <main className="shell">
    <header className="header"><div><h1 className="brand">{initial ? "Nhân bản bài viết" : "Soạn bài"}</h1><div className="subtle">{initial ? "Chỉnh lại nếu cần rồi đăng như một bài mới" : "Đăng ngay hoặc lưu lịch đăng"}</div></div><Link className="btn" href="/posts">Quay lại bài viết</Link></header>
    {!pages.length ? <section className="panel">Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> trước khi soạn bài.</section> :
      <section className="panel"><PostComposer pages={pages} initial={initial} limits={clientLimits(mediaLimits)} /></section>}
  </main>;
}
