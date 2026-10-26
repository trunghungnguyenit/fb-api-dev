"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { callApi, userMessage } from "@/lib/client-api";
import { Toast } from "@/app/toast";

// Actions for a Fanpage the user removed: bring it back, or (only when it has no posts) delete it for good.
export default function RemovedPageActions({ pageId, pageName, canDelete }: { pageId: string; pageName: string; canDelete: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"restore" | "delete" | null>(null);
  const [error, setError] = useState("");
  const confirm = useConfirm();

  async function run(kind: "restore" | "delete") {
    if (kind === "delete" && !(await confirm({
      title: `Xóa hẳn Fanpage “${pageName}”?`,
      message: "Fanpage này không còn bài viết nào. Muốn dùng lại, bạn phải bấm “Kết nối Facebook”.",
      confirmLabel: "Xóa hẳn", tone: "danger"
    }))) return;
    setBusy(kind); setError("");
    try {
      if (kind === "restore") await callApi(`/api/facebook/pages/${pageId}/restore`, { method: "POST" });
      else await callApi(`/api/facebook/pages/${pageId}`, { method: "DELETE" });
      router.push(kind === "restore" ? "/pages?restored=1" : "/pages?deleted=1");
      router.refresh();
    } catch (e) { setError(userMessage(e)); }
    finally { setBusy(null); }
  }

  return <div>
    <div className="row-actions-line">
      <button type="button" className="btn small primary" disabled={busy !== null} onClick={() => void run("restore")}>{busy === "restore" ? "Đang kết nối…" : "Kết nối lại"}</button>
      {canDelete && <button type="button" className="btn small danger" disabled={busy !== null} onClick={() => void run("delete")}>{busy === "delete" ? "Đang xóa…" : "Xóa hẳn"}</button>}
    </div>
    {error && <Toast kind="error" text={error} />}
  </div>;
}
