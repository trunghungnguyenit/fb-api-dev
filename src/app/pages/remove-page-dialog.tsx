"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import type { Impact } from "@/lib/page-removal";

type Load = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; impact: Impact } | { kind: "error"; text: string };

/** The content of the confirmation: exactly what will and will not happen. Exported so it can be previewed. */
export function RemoveImpact({ pageName, impact }: { pageName: string; impact: Impact }) {
  return <ul className="impact-list">
    {impact.willCancel > 0
      ? <li><strong>Hủy {impact.willCancel} bài chưa đăng</strong> ({impact.scheduled} đã lên lịch, {impact.drafts} nháp, {impact.failed} lỗi). Các bài này chuyển sang “Đã hủy” kèm lý do; muốn đăng lại, dùng nút “Đăng lại”.</li>
      : <li>Không có bài chưa đăng nào bị hủy.</li>}
    {impact.ambiguousKept > 0 && <li>{impact.ambiguousKept} bài chưa rõ kết quả được <strong>giữ nguyên</strong> để bạn kiểm tra trên Facebook.</li>}
    {impact.published > 0
      ? <li><strong>Giữ lịch sử {impact.published} bài đã đăng.</strong> Ứng dụng sẽ chưa xem được số liệu, sửa hoặc xóa các bài này trên Facebook cho đến khi bạn kết nối lại Fanpage.</li>
      : <li>Fanpage chưa có bài nào đã đăng.</li>}
    <li>Ứng dụng <strong>xóa token đã lưu</strong> của “{pageName}” và không tự thêm lại khi đồng bộ với Facebook.</li>
    <li className="subtle">Fanpage vẫn nằm trong danh sách ứng dụng của bạn trên Facebook. Muốn thu hồi hoàn toàn: Facebook → Cài đặt → Ứng dụng và trang web.</li>
  </ul>;
}

// "Gỡ" button + a native <dialog> (focus trap, Esc to close). The impact is loaded fresh when it opens.
export default function RemovePageButton({ pageId, pageName }: { pageId: string; pageName: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setError(""); setLoad({ kind: "loading" });
    dialog.current?.showModal();
    try {
      const result = await callApi<{ impact: Impact }>(`/api/facebook/pages/${pageId}/impact`, { method: "GET" });
      setLoad({ kind: "ready", impact: result.impact });
    } catch (e) { setLoad({ kind: "error", text: userMessage(e) }); }
  }

  const close = () => dialog.current?.close();

  async function confirm() {
    setBusy(true); setError("");
    try {
      const result = await callApi<{ cancelled: number }>(`/api/facebook/pages/${pageId}/remove`, { method: "POST" });
      close();
      router.push(`/pages?removed=${result.cancelled}`);
      router.refresh();
    } catch (e) { setError(userMessage(e)); }
    finally { setBusy(false); }
  }

  const blocked = load.kind === "ready" && load.impact.publishing > 0;
  return <>
    <button type="button" className="btn small danger" onClick={() => void open()}>Gỡ</button>
    <dialog ref={dialog} className="dialog" aria-labelledby={`remove-title-${pageId}`}
      onClick={(e) => { if (e.target === dialog.current && !busy) close(); }}>
      <div className="dialog-body">
        <h2 id={`remove-title-${pageId}`}>Gỡ Fanpage “{pageName}”?</h2>
        {load.kind === "loading" && <p className="subtle" role="status">Đang kiểm tra các bài của Fanpage này…</p>}
        {load.kind === "error" && <p className="error" role="alert">{load.text}</p>}
        {load.kind === "ready" && <>
          <RemoveImpact pageName={pageName} impact={load.impact} />
          {blocked && <p className="error" role="alert">Đang có {load.impact.publishing} bài được đăng lên Facebook. Hãy thử lại sau ít giây.</p>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions dialog-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>Hủy</button>
          <button type="button" className="btn danger solid" onClick={() => void confirm()} disabled={busy || load.kind !== "ready" || blocked}>
            {busy ? "Đang gỡ…" : "Gỡ Fanpage"}
          </button>
        </div>
      </div>
    </dialog>
  </>;
}
