"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import RowActions from "./row-actions";

export type PostRowView = {
  id: string;
  text: string;
  pageName: string;
  status: string;
  statusText: string;
  timeLabel: string | null;
  timeValue: string;
  errorText: string;
  lastErrorCode: string | null;
  facebookPostId: string | null;
  reposted: boolean;
  canRepost: boolean;
  editable: boolean;
};

/** "1171329916068581_122124078537403780" -> "117132…403780": enough to recognise, full id is on the detail page. */
function shortId(id: string) {
  return id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

type BulkResult = { done: number; skipped: { id: string; code: string; message: string }[] };
type BulkAction = "cancel" | "delete" | "repost-draft" | "repost-now";
type Notice = { kind: "success" | "error"; text: string; details?: string[] } | null;

const VERB: Record<BulkAction, string> = {
  cancel: "Hủy lịch", delete: "Xóa", "repost-draft": "Tạo bản nháp đăng lại cho", "repost-now": "Đăng lại ngay"
};
const DONE: Record<BulkAction, string> = { cancel: "Đã hủy", delete: "Đã xóa", "repost-draft": "Đã tạo", "repost-now": "Đã tạo" };

function confirmText(action: BulkAction, count: number) {
  const head = `${VERB[action]} ${count} bài đã chọn?`;
  if (action === "delete") return `${head}\n\nChỉ xóa các bài chưa đăng. Bài đã đăng lên Facebook sẽ được bỏ qua (xóa từng bài ở trang chi tiết).`;
  if (action === "cancel") return head;
  const live = "\n\nMỗi bài được sao chép thành một bài mới. Bài còn trên Facebook sẽ được bỏ qua (hãy đăng lại từng bài để xác nhận).";
  return action === "repost-now" ? `${head}${live}\nCác bài mới sẽ được đăng lên Facebook ngay.` : `${head}${live}`;
}

export default function PostsTable({ posts }: { posts: PostRowView[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const allRef = useRef<HTMLInputElement>(null);

  const ids = useMemo(() => posts.map((p) => p.id), [posts]);
  // Drop selections for posts that are no longer on this page (after a refresh, filter or bulk action).
  useEffect(() => { setSelected((prev) => new Set([...prev].filter((id) => ids.includes(id)))); }, [ids]);
  const allSelected = ids.length > 0 && selected.size === ids.length;
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selected.size > 0 && !allSelected; }, [selected, allSelected]);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ids));

  async function bulk(action: BulkAction) {
    if (!window.confirm(confirmText(action, selected.size))) return;
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
    <div role={notice?.kind === "error" ? "alert" : "status"} aria-live="polite">
      {notice && <div className={notice.kind} style={{ marginBottom: 12 }}>
        <div>{notice.text}</div>
        {notice.details?.map((d) => <div key={d} className="subtle">{d}</div>)}
      </div>}
    </div>

    <div className="table-wrap"><table className="posts-table">
      <thead><tr>
        <th scope="col"><input ref={allRef} type="checkbox" aria-label="Chọn tất cả bài trên trang này" checked={allSelected} onChange={toggleAll} disabled={ids.length === 0} /></th>
        <th scope="col" className="col-content">Nội dung</th><th scope="col">Fanpage</th><th scope="col">Trạng thái</th>
        <th scope="col">Thời gian</th><th scope="col" className="col-error">Lỗi</th><th scope="col" className="col-actions">Thao tác</th>
      </tr></thead>
      <tbody>
        {posts.map((post) => <tr key={post.id}>
          <td><input type="checkbox" aria-label="Chọn bài này" checked={selected.has(post.id)} onChange={() => toggle(post.id)} /></td>
          <td>
            <Link href={`/posts/${post.id}`}>{post.text}</Link>{post.reposted && <span className="badge">Đăng lại</span>}
            {post.facebookPostId && <div className="subtle cell-meta" title={post.facebookPostId}>ID Facebook: {shortId(post.facebookPostId)}</div>}
          </td>
          <td className="cell-nowrap">{post.pageName}</td>
          <td><span className="pill">{post.statusText}</span></td>
          <td className="cell-nowrap">
            {post.timeLabel && <div className="subtle cell-meta">{post.timeLabel}</div>}
            <div>{post.timeValue}</div>
          </td>
          <td className="col-error"><span className="error-clamp" title={post.errorText}>{post.errorText}</span></td>
          <td className="col-actions">
            <RowActions id={post.id} status={post.status} lastErrorCode={post.lastErrorCode} canRepost={post.canRepost} editable={post.editable} />
          </td>
        </tr>)}
        {!posts.length && <tr><td colSpan={7}>Không có bài viết nào.</td></tr>}
      </tbody>
    </table></div>
  </>;
}
