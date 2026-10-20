import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { AppFailure, messageFor, REF_PATTERN, withRef } from "@/lib/errors";
import { taskLabel } from "@/lib/labels";
import ClearQuery from "../clear-query";

export const dynamic = "force-dynamic";

type PageRow = { id: string; page_id: string; page_name: string; tasks: string[] | null; is_active: boolean };
type Search = { error?: string; ref?: string; connected?: string; checked?: string; deactivated?: string; page_errors?: string };

const count = (value?: string) => Math.max(0, Math.min(Number(value) || 0, 9999));

export default async function PagesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { error, ref, connected, checked, deactivated, page_errors } = await searchParams;
  const { data: pages, error: dbError } = await userDb(user.id).pages
    .select("id,page_id,page_name,tasks,is_active,created_at").order("page_name");
  if (dbError) throw new AppFailure("DB_ERROR", dbError);

  const hasBanner = Boolean(error || connected || checked || deactivated || page_errors);
  const deactivatedCount = count(deactivated);
  const failedCount = count(page_errors);
  return <main className="shell">
    <header className="header"><div><h1 className="brand">Fanpage</h1><div className="subtle">Kết nối các Facebook Page mà bạn có quyền quản lý</div></div>
      <div className="actions">
        <Link className="btn" href="/">Trang chủ</Link>
        <form action="/api/facebook/pages/check" method="post"><button className="btn" type="submit">Kiểm tra lại quyền</button></form>
        <a className="btn primary" href="/api/auth/facebook">Kết nối Facebook</a>
      </div>
    </header>
    {hasBanner && <ClearQuery />}
    {error && <p className="error" role="alert">{withRef(messageFor(error), ref && REF_PATTERN.test(ref) ? ref : null)}</p>}
    {connected && <p className="success">Đã kết nối Facebook.{failedCount ? ` ${failedCount} Fanpage không lưu được, hãy thử lại.` : ""}</p>}
    {checked && <p className="success">Đã kiểm tra quyền các Fanpage.</p>}
    {deactivatedCount > 0 && <p className="error">{deactivatedCount} Fanpage đã mất quyền và bị tắt. Các bài đã lên lịch của Fanpage đó vẫn được giữ trong hàng đợi và sẽ tự đăng sau khi bạn kết nối lại Facebook.</p>}
    <section className="panel"><div className="table-wrap"><table><thead><tr><th scope="col">Tên Fanpage</th><th scope="col">ID Fanpage</th><th scope="col">Quyền</th><th scope="col">Trạng thái</th></tr></thead><tbody>
      {rows<PageRow>(pages).map(page => <tr key={page.id}><td>{page.page_name}</td><td>{page.page_id}</td><td>{(page.tasks ?? []).map(taskLabel).join(", ") || "Không có dữ liệu"}</td><td><span className="pill">{page.is_active ? "Đang kết nối" : "Đã tắt (mất quyền)"}</span></td></tr>)}
      {!pages?.length && <tr><td colSpan={4}>Chưa có Fanpage. Chọn “Kết nối Facebook” để cấp quyền.</td></tr>}
    </tbody></table></div></section>
  </main>;
}
