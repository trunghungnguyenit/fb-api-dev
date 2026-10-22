import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { AppFailure } from "@/lib/errors";
import { formatDateTime, statusLabel } from "@/lib/labels";
import UndoImportButton from "./undo-button";
import StatusPill, { postTone } from "@/app/status-pill";

export const dynamic = "force-dynamic";

type Batch = {
  id: string; source_name: string | null; source_format: string | null; row_count: number; created_count: number;
  skipped_count: number; undone_at: string | null; undone_count: number | null; created_at: string;
};

const FORMAT_LABELS: Record<string, string> = { csv: "CSV", xlsx: "Excel", json: "JSON", paste: "Dán" };
// Status order for the "now" summary of each batch.
const STATUS_ORDER = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"];

export default async function ImportHistoryPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const db = userDb(user.id);

  const [batchResult, statsResult] = await Promise.all([
    db.imports.select("id,source_name,source_format,row_count,created_count,skipped_count,undone_at,undone_count,created_at")
      .order("created_at", { ascending: false }).limit(50),
    supabaseAdmin.rpc("import_batch_stats", { p_user: user.id })
  ]);
  if (batchResult.error) throw new AppFailure("DB_ERROR", batchResult.error);
  if (statsResult.error) throw new AppFailure("DB_ERROR", statsResult.error);
  const batches = rows<Batch>(batchResult.data);

  // batch id -> status -> count
  const stats = new Map<string, Map<string, number>>();
  for (const s of rows<{ batch_id: string; status: string; n: number }>(statsResult.data)) {
    const m = stats.get(s.batch_id) ?? new Map<string, number>();
    m.set(s.status, Number(s.n));
    stats.set(s.batch_id, m);
  }

  return <main className="shell">
    <header className="header">
      <div><h1 className="brand">Lịch sử Import bài viết</h1><div className="subtle">Xem lại các lần nhập và hoàn tác nếu nhập nhầm</div></div>
      <div className="actions"><Link className="btn primary" href="/posts/import">Import bài viết mới</Link><Link className="btn" href="/posts">Quay lại bài viết</Link></div>
    </header>
    <section className="panel">
      <div className="table-wrap"><table>
        <thead><tr>
          <th scope="col">Thời gian</th><th scope="col">Nguồn</th><th scope="col">Dòng</th><th scope="col">Hiện tại</th><th scope="col" className="col-actions">Thao tác</th>
        </tr></thead>
        <tbody>
          {batches.map((b) => {
            const now = stats.get(b.id) ?? new Map<string, number>();
            const undoable = (now.get("draft") ?? 0) + (now.get("scheduled") ?? 0);
            return <tr key={b.id}>
              <td className="cell-nowrap">{formatDateTime(b.created_at)}</td>
              <td>{b.source_name ?? "—"}{b.source_format && <span className="badge">{FORMAT_LABELS[b.source_format] ?? b.source_format}</span>}</td>
              <td className="cell-nowrap">{b.row_count} dòng<div className="subtle cell-meta">nhập {b.created_count} · bỏ qua {b.skipped_count}</div></td>
              <td>
                {b.undone_at
                  ? <span className="subtle">Đã hoàn tác {formatDateTime(b.undone_at)} (xóa {b.undone_count ?? 0})</span>
                  : STATUS_ORDER.filter((s) => now.get(s)).map((s) => <span key={s} className="pill-gap"><StatusPill tone={postTone(s)}>{now.get(s)} {statusLabel(s).toLowerCase()}</StatusPill></span>)}
                {!b.undone_at && now.size === 0 && <span className="subtle">Các bài đã bị xóa</span>}
              </td>
              <td className="col-actions">
                <div className="row-actions-line">
                  {now.size > 0 && <Link className="btn small" href={`/posts?batch=${b.id}`}>Xem bài</Link>}
                  {!b.undone_at && undoable > 0 && <UndoImportButton batchId={b.id} undoable={undoable} />}
                </div>
              </td>
            </tr>;
          })}
          {batches.length === 0 && <tr><td colSpan={5}>Chưa có lần nhập nào. <Link href="/posts/import">Import bài viết đầu tiên</Link>.</td></tr>}
        </tbody>
      </table></div>
    </section>
  </main>;
}
