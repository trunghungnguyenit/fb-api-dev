import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { AppFailure } from "@/lib/errors";
import PostComposer from "./post-composer";

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
  let initial: { pageId: string; message: string; linkUrl: string } | undefined;
  if (from && z.string().uuid().safeParse(from).success) {
    const { data: source, error: sourceError } = await db.posts.select("page_id,message,link_url").eq("id", from).maybeSingle();
    if (sourceError) throw new AppFailure("DB_ERROR", sourceError);
    const post = one<{ page_id: string; message: string; link_url: string | null }>(source);
    if (post) initial = {
      // Keep the original Page when it is still connected, otherwise let the user pick one.
      pageId: pages.some((p) => p.id === post.page_id) ? post.page_id : (pages[0]?.id ?? ""),
      message: post.message, linkUrl: post.link_url ?? ""
    };
  }

  return <main className="shell">
    <header className="header"><div><h1 className="brand">{initial ? "Nhân bản bài viết" : "Soạn bài"}</h1><div className="subtle">{initial ? "Chỉnh lại nếu cần rồi đăng như một bài mới" : "Đăng ngay hoặc lưu lịch đăng"}</div></div><Link className="btn" href="/posts">Quay lại bài viết</Link></header>
    {!pages.length ? <section className="panel">Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> trước khi soạn bài.</section> :
      <section className="panel"><PostComposer pages={pages} initial={initial} /></section>}
  </main>;
}
