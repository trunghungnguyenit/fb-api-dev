"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { callApi, userMessage } from "@/lib/client-api";

// Removes the not-yet-published posts of one import. Published or in-flight posts are kept by the server.
export default function UndoImportButton({ batchId, undoable }: { batchId: string; undoable: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirm();

  async function undo() {
    if (!(await confirm({ title: "Hoàn tác lần nhập này?", message: `${undoable} bài nháp/đã lên lịch chưa đăng sẽ bị xóa. Bài đã đăng được giữ nguyên.`, confirmLabel: "Hoàn tác", tone: "danger" }))) return;
    setBusy(true); setError("");
    try {
      await callApi(`/api/posts/import/${batchId}/undo`, { method: "POST" });
      router.refresh();
    } catch (e) { setError(userMessage(e)); setBusy(false); }
  }

  return <div>
    <button type="button" className="btn small danger" disabled={busy} onClick={() => void undo()}>{busy ? "Đang hoàn tác…" : `Hoàn tác (${undoable})`}</button>
    {error && <p className="row-error" role="alert">{error}</p>}
  </div>;
}
