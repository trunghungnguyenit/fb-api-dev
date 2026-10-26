"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ConfirmOptions, useConfirm } from "@/app/confirm-dialog";
import { callApi, userMessage } from "@/lib/client-api";
import ErrorCell from "./error-cell";
import StatusPill, { postTone } from "@/app/status-pill";
import RowActions from "./row-actions";
import { Toast } from "@/app/toast";

export type PostRowView = {
  id: string;
  text: string;
  /** "1 ảnh" / "Nhiều ảnh" for posts with images. */
  kind: string | null;
  pageName: string;
  status: string;
  statusText: string;
  /** The post is gone from Facebook (its status stays "published"). */
  deleted: boolean;
  hasError: boolean;
  timeLabel: string | null;
  timeValue: string;
  errorText: string;
  lastErrorCode: string | null;
  facebookPostId: string | null;
  reposted: boolean;
  note: string | null;
  canRepost: boolean;
  editable: boolean;
};

/** "1171329916068581_122124078537403780" -> "117132…403780": enough to recognise, full id is on the detail page. */
function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

/** What /api/posts/bulk accepts in one request. */
const BULK_MAX = 50;

type BulkResult = { done: number; skipped: { id: string; code: string; message: string }[] };
type BulkAction = "cancel" | "delete" | "repost-draft" | "repost-now";
type Notice = { kind: "success" | "error"; text: string; details?: string[] } | null;

const VERB: Record<BulkAction, string> = {
  cancel: "Hủy lịch", delete: "Xóa", "repost-draft": "Tạo bản nháp đăng lại cho", "repost-now": "Đăng lại ngay"
};
const DONE: Record<BulkAction, string> = { cancel: "Đã hủy", delete: "Đã xóa", "repost-draft": "Đã tạo", "repost-now": "Đã tạo" };

function confirmOptions(action: BulkAction, count: number): ConfirmOptions {
  const title = `${VERB[action]} ${count} bài đã chọn?`;
  if (action === "delete") return { title, message: "Chỉ xóa các bài chưa đăng. Bài đã đăng lên Facebook sẽ được bỏ qua (xóa từng bài ở trang chi tiết).", confirmLabel: "Xóa", tone: "danger" };
  if (action === "cancel") return { title, confirmLabel: "Hủy lịch" };
  const live = "Mỗi bài được sao chép thành một bài mới. Bài còn trên Facebook sẽ được bỏ qua (hãy đăng lại từng bài để xác nhận).";
  return action === "repost-now"
    ? { title, message: `${live}\nCác bài mới sẽ được đăng lên Facebook ngay.`, confirmLabel: "Đăng lại ngay", tone: "danger" }
    : { title, message: live, confirmLabel: "Tạo bản nháp" };
}

export default function PostsTable({ posts }: { posts: PostRowView[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const allRef = useRef<HTMLInputElement>(null);

  const ids = useMemo(() => posts.map((p) => p.id), [posts]);
  // Drop selections for posts that are no longer on this page (after a refresh, filter or bulk action).
  useEffect(() => { setSelected((prev) => new Set([...prev].filter((id) => ids.includes(id)))); }, [ids]);
  const allSelected = ids.length > 0 && selected.size === ids.length;
  const allPossible = ids.length > 0 && selected.size === Math.min(ids.length, BULK_MAX);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selected.size > 0 && !allPossible; }, [selected, allPossible]);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleAll = () => {
    if (allSelected || selected.size >= Math.min(ids.length, BULK_MAX)) { setSelected(new Set()); return; }
    setSelected(new Set(ids.slice(0, BULK_MAX)));
    if (ids.length > BULK_MAX) setNotice({ kind: "success", text: `Đã chọn ${BULK_MAX} bài đầu danh sách: mỗi lần thao tác tối đa ${BULK_MAX} bài.` });
  };

  async function bulk(action: BulkAction) {
    if (!(await confirm(confirmOptions(action, selected.size)))) return;
    const repost = action === "repost-draft" || action === "repost-now";
    setBusy(action); setNotice(null);
    try {
      const result = await callApi<BulkResult>("/api/posts/bulk", {
        method: "POST",
        body: repost ? { action: "repost", ids: [...selected], when: action === "repost-now" ? "now" : "draft" } : { action, ids: [...selected] }
      });
      const groups = new Map<string, number>();
      for (const s of result.skipped) groups.set(s.message, (groups.get(s.message) ?? 0) + 1);
      setNotice({
        kind: result.done > 0 || result.skipped.length === 0 ? "success" : "error",
        text: `${DONE[action]} ${result.done} bài.${result.skipped.length ? ` Bỏ qua ${result.skipped.length} bài.` : ""}`,
        details: [...groups].map(([message, n]) => `${n} bài: ${message}`)
      });
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setNotice({ kind: "error", text: userMessage(e) });
    } finally { setBusy(null); }
  }

  const disabled = busy !== null;
  return <>
    {selected.size > 0 && <div className="bulk-bar" role="region" aria-label="Thao tác hàng loạt">
      <strong>Đã chọn {selected.size} bài</strong>
      <div className="actions">
        <button className="btn small" type="button" disabled={disabled} onClick={() => void bulk("cancel")}>{busy === "cancel" ? "Đang hủy…" : "Hủy lịch"}</button>
        <button className="btn small" type="button" disabled={disabled} onClick={() => void bulk("repost-draft")}>{busy === "repost-draft" ? "Đang tạo…" : "Đăng lại (tạo bản nháp)"}</button>
        <button className="btn small" type="button" disabled={disabled} onClick={() => void bulk("repost-now")}>{busy === "repost-now" ? "Đang đăng…" : "Đăng lại ngay"}</button>
        <button className="btn small danger" type="button" disabled={disabled} onClick={() => void bulk("delete")}>{busy === "delete" ? "Đang xóa…" : "Xóa"}</button>
        <button className="btn small" type="button" disabled={disabled} onClick={() => setSelected(new Set())}>Bỏ chọn</button>
      </div>
    </div>}
    {notice && <Toast kind={notice.kind} text={notice.text} details={notice.details} />}

    <div className="table-wrap"><table className="posts-table cards">
      <thead><tr>
        <th scope="col"><input ref={allRef} type="checkbox" aria-label={ids.length > BULK_MAX ? `Chọn ${BULK_MAX} bài đầu danh sách` : "Chọn tất cả bài trong danh sách"} checked={allPossible} onChange={toggleAll} disabled={ids.length === 0} /></th>
        <th scope="col" className="col-content">Nội dung</th><th scope="col">Fanpage</th><th scope="col">Trạng thái</th>
        <th scope="col">Thời gian</th><th scope="col" className="col-error">Lỗi</th><th scope="col" className="col-actions">Thao tác</th>
      </tr></thead>
      <tbody>
        {posts.map((post) => <tr key={post.id}>
          <td data-label=""><input type="checkbox" aria-label="Chọn bài này" checked={selected.has(post.id)} onChange={() => toggle(post.id)} /></td>
          <td className="col-content" data-label="Nội dung">
            <Link href={`/posts/${post.id}`}>{post.text}</Link>{post.kind && <span className="badge">{post.kind}</span>}{post.reposted && <span className="badge">Đăng lại</span>}
            {post.note && <div className="subtle cell-meta cell-note" title={post.note}>Ghi chú: {post.note}</div>}
            {post.facebookPostId && <div className="subtle cell-meta" title={post.facebookPostId}>ID Facebook: <span className="mono">{shortId(post.facebookPostId)}</span></div>}
          </td>
          <td className="cell-nowrap" data-label="Fanpage">{post.pageName}</td>
          <td data-label="Trạng thái"><StatusPill tone={postTone(post.status, post.deleted)}>{post.statusText}</StatusPill></td>
          <td className="cell-nowrap" data-label="Thời gian"><div>
            {post.timeLabel && <div className="subtle cell-meta">{post.timeLabel}</div>}
            {post.timeValue === "—" ? <span className="cell-none">—</span> : <div className="mono time-value">{post.timeValue}</div>}
          </div></td>
          <td className="col-error" data-label="Lỗi">{post.hasError ? <ErrorCell text={post.errorText} /> : <span className="cell-none">—</span>}</td>
          <td className="col-actions" data-label="Thao tác">
            <RowActions id={post.id} status={post.status} lastErrorCode={post.lastErrorCode} canRepost={post.canRepost} editable={post.editable} deletedOnFacebook={post.deleted} />
          </td>
        </tr>)}
        {!posts.length && <tr><td colSpan={7}>Không có bài viết nào.</td></tr>}
      </tbody>
    </table></div>
  </>;
}
