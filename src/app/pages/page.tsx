import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { AppFailure, messageFor, REF_PATTERN, withRef } from "@/lib/errors";
import { formatDateTime, taskLabel } from "@/lib/labels";
import { connectionAttention, featureLabels } from "@/lib/meta/token-health";
import { unavailableFeatures } from "@/lib/meta/scopes";
import StatusPill from "@/app/status-pill";
import ClearQuery from "../clear-query";
import { Toast } from "../toast";
import RemovePageButton from "./remove-page-dialog";
import RemovedPageActions from "./removed-page-actions";

export const dynamic = "force-dynamic";

type PageRow = {
  id: string; page_id: string; page_name: string; tasks: string[] | null; is_active: boolean; removed_at: string | null;
  feed_synced_at: string | null; feed_sync_error: string | null;
};
type ConnectionRow = { id: string; meta_user_name: string | null; scopes: string[] | null; token_is_valid: boolean | null; token_expires_at: string | null; data_access_expires_at: string | null };
type Search = {
  error?: string; ref?: string; connected?: string; checked?: string; deactivated?: string; page_errors?: string;
  removed?: string; restored?: string; deleted?: string; feedsynced?: string;
};

const count = (value?: string) => Math.max(0, Math.min(Number(value) || 0, 9999));

export default async function PagesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { error, ref, connected, checked, deactivated, page_errors, removed, restored, deleted, feedsynced } = await searchParams;
  const [pagesResult, countsResult, connectionsResult] = await Promise.all([
    userDb(user.id).pages.select("id,page_id,page_name,tasks,is_active,removed_at,created_at,feed_synced_at,feed_sync_error").order("page_name"),
    // Posts per Fanpage: which removed Fanpages still hold history (and so cannot be deleted for good).
    supabaseAdmin.rpc("page_post_counts", { p_user: user.id, p_page: null }),
    // Token health from the last check (Meta's debug_token): which connections need the user's attention.
    userDb(user.id).connections.select("id,meta_user_name,scopes,token_is_valid,token_expires_at,data_access_expires_at")
  ]);
  if (pagesResult.error) throw new AppFailure("DB_ERROR", pagesResult.error);
  if (countsResult.error) throw new AppFailure("DB_ERROR", countsResult.error);
  if (connectionsResult.error) throw new AppFailure("DB_ERROR", connectionsResult.error);

  const all = rows<PageRow>(pagesResult.data);
  const connected_ = all.filter((p) => !p.removed_at);
  const removedPages = all.filter((p) => p.removed_at);
  const postsByPage = new Map<string, number>();
  for (const c of rows<{ page_id: string; n: number | string }>(countsResult.data)) {
    postsByPage.set(c.page_id, (postsByPage.get(c.page_id) ?? 0) + Number(c.n));
  }

  const attention = rows<ConnectionRow>(connectionsResult.data)
    .map((c) => ({ id: c.id, name: c.meta_user_name, state: connectionAttention(c) }))
    .filter((c) => c.state !== null);
  // Features this connection's permissions do not cover yet (for instance comments, added after it was connected).
  const needMore = rows<ConnectionRow>(connectionsResult.data)
    .map((c) => ({ id: c.id, name: c.meta_user_name, features: featureLabels(unavailableFeatures(c.scopes)) }))
    .filter((c) => c.features.length > 0);
  const hasBanner = Boolean(error || connected || checked || deactivated || page_errors || removed !== undefined || restored || deleted || feedsynced);
  const deactivatedCount = count(deactivated);
  const failedCount = count(page_errors);
  const cancelledCount = count(removed);
  return <main className="shell">
    <header className="header"><div><h1 className="brand">Fanpage</h1><div className="subtle">Kết nối các Facebook Page mà bạn có quyền quản lý</div></div>
      <div className="actions">
        <form action="/api/facebook/pages/check" method="post"><button className="btn" type="submit">Kiểm tra lại quyền</button></form>
        <a className="btn primary" href="/api/auth/facebook">Kết nối Facebook</a>
      </div>
    </header>
    {hasBanner && <ClearQuery />}
    {error && <Toast kind="error" text={withRef(messageFor(error), ref && REF_PATTERN.test(ref) ? ref : null)} />}
    {connected && <Toast kind="success" text={`Đã kết nối Facebook.${failedCount ? ` ${failedCount} Fanpage không lưu được, hãy thử lại.` : ""}`} />}
    {checked && <Toast kind="success" text="Đã kiểm tra quyền các Fanpage." />}
    {removed !== undefined && <Toast kind="success" text={`Đã gỡ Fanpage.${cancelledCount > 0 ? ` Đã hủy ${cancelledCount} bài chưa đăng.` : ""} Fanpage nằm trong mục “Fanpage đã gỡ” bên dưới; bạn có thể kết nối lại bất cứ lúc nào.`} />}
    {restored && <Toast kind="success" text="Đã kết nối lại Fanpage." />}
    {feedsynced && <Toast kind={feedsynced === "recent" ? "warning" : "success"} text={feedsynced === "recent" ? "Fanpage này vừa được đồng bộ, hãy thử lại sau ít phút." : `Đã đọc ${count(feedsynced)} bài từ Facebook.`} />}
    {deleted && <Toast kind="success" text="Đã xóa hẳn Fanpage khỏi danh sách." />}
    {deactivatedCount > 0 && <Toast kind="error" text={`${deactivatedCount} Fanpage đã mất quyền và bị tắt. Các bài đã lên lịch của Fanpage đó vẫn được giữ trong hàng đợi và sẽ tự đăng sau khi bạn kết nối lại Facebook.`} />}

    {attention.map(({ id, name, state }) => state?.kind === "invalid"
      ? <p key={id} className="error" role="alert">Kết nối Facebook{name ? ` (${name})` : ""} cần xác thực lại: Facebook không còn chấp nhận quyền truy cập đã lưu, nên các Fanpage thuộc kết nối này chưa đăng được bài. Bấm “Kết nối Facebook” để cấp quyền lại.</p>
      : <p key={id} className="notice" role="status">Quyền truy cập dữ liệu của kết nối Facebook{name ? ` (${name})` : ""} sẽ hết hạn sau khoảng {state?.kind === "expiring" ? state.days : 0} ngày. Hãy bấm “Kết nối Facebook” trước thời điểm đó để các Fanpage không bị gián đoạn.</p>)}

    {needMore.map(({ id, name, features }) => <p key={id} className="notice" role="note">
      Kết nối Facebook{name ? ` (${name})` : ""} chưa được cấp quyền để {features.join(", ")}. Bấm “Kết nối Facebook” và tích chọn tất cả các quyền được yêu cầu để dùng tính năng này; các tính năng khác vẫn hoạt động bình thường.
    </p>)}

    <section className="panel"><div className="table-wrap"><table className="cards"><thead><tr>
      <th scope="col">Tên Fanpage</th><th scope="col">ID Fanpage</th><th scope="col">Quyền</th><th scope="col">Trạng thái</th><th scope="col">Bài từ Facebook</th><th scope="col" className="col-actions">Thao tác</th>
    </tr></thead><tbody>
      {connected_.map((page) => <tr key={page.id}>
        <td data-label="Tên Fanpage">{page.page_name}</td><td data-label="ID Fanpage">{page.page_id}</td>
        <td data-label="Quyền">{(page.tasks ?? []).map(taskLabel).join(", ") || "Không có dữ liệu"}</td>
        <td data-label="Trạng thái"><StatusPill tone={page.is_active ? "published" : "cancelled"}>{page.is_active ? "Đang kết nối" : "Đã tắt (mất quyền)"}</StatusPill></td>
        <td data-label="Bài từ Facebook">{page.is_active ? <>
          <div className="cell-nowrap">{page.feed_synced_at ? `Đọc lúc ${formatDateTime(page.feed_synced_at)}` : "Chưa đọc lần nào"}</div>
          {page.feed_sync_error && <div className="row-error">{messageFor(page.feed_sync_error)}</div>}
          <form action={`/api/facebook/pages/${page.id}/sync`} method="post"><button className="link-button" type="submit">Đồng bộ bài ngay</button></form>
        </> : <span className="subtle">—</span>}</td>
        <td data-label="Thao tác" className="col-actions"><RemovePageButton pageId={page.id} pageName={page.page_name} /></td>
      </tr>)}
      {connected_.length === 0 && <tr><td colSpan={6}>Chưa có Fanpage nào đang kết nối. Chọn “Kết nối Facebook” để cấp quyền.</td></tr>}
    </tbody></table></div></section>

    {removedPages.length > 0 && <details className="panel removed-panel">
      <summary>Fanpage đã gỡ ({removedPages.length})</summary>
      <p className="subtle">Các Fanpage này không còn dùng để đăng bài và không tự quay lại khi đồng bộ với Facebook. Lịch sử bài viết được giữ nguyên.</p>
      <div className="table-wrap"><table className="cards"><thead><tr>
        <th scope="col">Tên Fanpage</th><th scope="col">ID Fanpage</th><th scope="col">Đã gỡ lúc</th><th scope="col">Bài viết</th><th scope="col" className="col-actions">Thao tác</th>
      </tr></thead><tbody>
        {removedPages.map((page) => {
          const posts = postsByPage.get(page.id) ?? 0;
          return <tr key={page.id}>
            <td data-label="Tên Fanpage">{page.page_name}</td><td data-label="ID Fanpage">{page.page_id}</td>
            <td data-label="Đã gỡ lúc" className="cell-nowrap">{page.removed_at ? formatDateTime(page.removed_at) : "—"}</td>
            <td data-label="Bài viết">{posts > 0 ? <Link href={`/posts?page=${page.id}`}>{posts} bài (lịch sử)</Link> : <span className="subtle">Không có</span>}</td>
            <td data-label="Thao tác" className="col-actions"><RemovedPageActions pageId={page.id} pageName={page.page_name} canDelete={posts === 0} /></td>
          </tr>;
        })}
      </tbody></table></div>
    </details>}
  </main>;
}
