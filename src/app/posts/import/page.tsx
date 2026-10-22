import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { mediaLimits } from "@/lib/media/config";
import { clientLimits } from "@/lib/media/limits";
import { AppFailure } from "@/lib/errors";
import ImportWizard from "./import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { data, error } = await userDb(user.id).pages.select("id,page_name").eq("is_active", true).order("page_name");
  if (error) throw new AppFailure("DB_ERROR", error);
  const pages = rows<{ id: string; page_name: string }>(data);

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Nhập nhiều bài viết</h1><div className="subtle">Bài viết, ảnh, nhiều ảnh, video và Reels. Tải lên CSV, Excel, JSON hoặc dán từ bảng tính, xem trước rồi mới nhập.</div></div>
      <div className="actions"><Link className="btn" href="/posts/imports">Lịch sử nhập</Link><Link className="btn" href="/posts">Quay lại bài viết</Link></div>
    </header>
    <section className="panel">
      {pages.length === 0
        ? <p>Bạn chưa có Fanpage nào đang kết nối. <Link href="/pages">Kết nối Facebook</Link> trước khi Import bài viết.</p>
        : <ImportWizard pages={pages} limits={clientLimits(mediaLimits)} />}
    </section>
  </main>;
}
