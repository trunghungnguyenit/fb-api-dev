"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";
import type { UserSyncStats } from "@/lib/feed-sync";
import { Toast } from "@/app/toast";

function summary(s: UserSyncStats) {
  if (s.pages === 0) return { ok: false, text: "Chưa có Fanpage nào đang hoạt động để đọc bài." };
  if (s.failed > 0) return { ok: false, text: `Chưa đọc được ${s.failed}/${s.pages} Fanpage: ${messageFor(s.lastError ?? "UNEXPECTED")}` };
  if (s.deferred > 0) return { ok: false, text: "Facebook đang giới hạn tốc độ, hệ thống sẽ tự đọc lại sau ít phút." };
  if (s.synced === 0) return { ok: true, text: "Dữ liệu vừa được cập nhật, hãy thử lại sau ít phút." };
  const parts = [s.created > 0 ? `${s.created} bài mới` : "", s.removed > 0 ? `${s.removed} bài đã bị xóa trên Facebook` : ""].filter(Boolean);
  return { ok: true, text: parts.length > 0 ? `Đã cập nhật: ${parts.join(", ")}.` : "Đã cập nhật, không có thay đổi." };
}

// Reads the Fanpages' posts from Facebook right now instead of waiting for the 15-minute turn.
export default function RefreshFeedButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true); setNote(null);
    try {
      setNote(summary(await callApi<UserSyncStats>("/api/facebook/sync", { method: "POST" })));
      router.refresh();
    } catch (e) { setNote({ ok: false, text: userMessage(e) }); }
    finally { setBusy(false); }
  }

  return <div className="refresh-feed">
    <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Đang tải lại…" : "↻ Tải lại từ Facebook"}</button>
    {note && <Toast kind={note.ok ? "success" : "error"} text={note.text} />}
  </div>;
}
