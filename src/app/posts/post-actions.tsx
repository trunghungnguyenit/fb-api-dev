"use client";

import { useState } from "react";
import { usePostActions } from "./use-post-actions";

type Props = { id: string; status: string; lastErrorCode: string | null };

// Full set of status controls for one post, used on the detail page: publish / retry, schedule, cancel.
// (The list uses the compact RowActions instead.)
export default function PostActions({ id, status, lastErrorCode }: Props) {
  const { busy, error, run } = usePostActions({ id, lastErrorCode });
  const [when, setWhen] = useState("");

  const canPublish = status === "draft" || status === "failed";
  const canCancel = status === "draft" || status === "scheduled" || status === "failed";
  if (!canPublish && !canCancel) return <span className="subtle">Không có thao tác nào cho trạng thái này.</span>;

  const disabled = busy !== null;
  return <div className="post-actions">
    <div className="actions">
      {canPublish && <button className="btn small primary" type="button" disabled={disabled} onClick={() => void run("publish")}>
        {busy === "publish" ? "Đang đăng…" : status === "failed" ? "Thử lại" : "Đăng ngay"}
      </button>}
      {canCancel && <button className="btn small danger" type="button" disabled={disabled} onClick={() => void run("cancel")}>
        {busy === "cancel" ? "Đang hủy…" : "Hủy"}
      </button>}
    </div>
    {status === "draft" && <div className="actions" style={{ marginTop: 8 }}>
      <input type="datetime-local" aria-label="Thời gian đăng" value={when} onChange={(e) => setWhen(e.target.value)} disabled={disabled} />
      <button className="btn small" type="button" disabled={disabled} onClick={() => void run("schedule", when)}>
        {busy === "schedule" ? "Đang lưu…" : "Lên lịch"}
      </button>
    </div>}
    {error && <p className="error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
  </div>;
}
