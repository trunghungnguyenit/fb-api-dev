"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";

type Page = { id: string; page_name: string; disabled: boolean };
type Props = {
  id: string;
  mode: "published" | "unpublished";
  status: string;
  ambiguous: boolean;
  initial: { pageId: string; message: string; linkUrl: string; scheduledAt: string | null };
  pages: Page[];
};

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PostEditor({ id, mode, status, ambiguous, initial, pages }: Props) {
  const router = useRouter();
  const published = mode === "published";
  const [pageId, setPageId] = useState(initial.pageId);
  const [message, setMessage] = useState(initial.message);
  const [linkUrl, setLinkUrl] = useState(initial.linkUrl);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Browser-local time is only known on the client (the server renders in its own timezone).
  const initialWhen = initial.scheduledAt ? toLocalInput(initial.scheduledAt) : "";
  useEffect(() => setWhen(initialWhen), [initialWhen]);

  const dirty = message !== initial.message || linkUrl !== initial.linkUrl || pageId !== initial.pageId || when !== initialWhen;

  async function save() {
    setError("");
    const body: Record<string, unknown> = { action: "edit" };
    if (message !== initial.message) body.message = message;
    if (!published) {
      if (linkUrl !== initial.linkUrl) body.linkUrl = linkUrl;
      if (pageId !== initial.pageId) body.pageId = pageId;
      if (when && when !== initialWhen) {
        if (new Date(when).getTime() < Date.now() - 60_000) return setError(messageFor("SCHEDULE_IN_PAST"));
        body.scheduledAt = new Date(when).toISOString();
        if (ambiguous && !window.confirm("Chưa rõ bài này đã được đăng lên Facebook hay chưa. Hãy kiểm tra Fanpage trước. Vẫn muốn lên lịch đăng lại?")) return;
        if (ambiguous) body.force = true;
      }
    } else if (!window.confirm("Facebook sẽ hiển thị nhãn “Đã chỉnh sửa” trên bài này và mọi người có thể xem lịch sử chỉnh sửa. Tiếp tục?")) {
      return;
    }
    setBusy(true);
    try {
      await callApi(`/api/posts/${id}`, { method: "PATCH", body });
      router.push(`/posts/${id}`);
      router.refresh();
    } catch (e) {
      setError(userMessage(e));
      setBusy(false);
    }
  }

  const willSchedule = !published && Boolean(when) && when !== initialWhen && status !== "scheduled";

  return <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {published && <p className="notice" role="note">
      Bài đã đăng lên Facebook nên <strong>chỉ sửa được nội dung chữ</strong>. Muốn đổi liên kết, Fanpage hoặc giờ đăng, hãy nhân bản bài rồi đăng lại (bài cũ sẽ được giữ nguyên).
    </p>}

    <div className="field"><label htmlFor="page">Fanpage</label>
      <select id="page" value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={published || busy}>
        {pages.map((p) => <option key={p.id} value={p.id} disabled={p.disabled && p.id !== initial.pageId}>{p.page_name}</option>)}
      </select></div>

    <div className="field"><label htmlFor="message">Nội dung</label>
      <textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={63206} disabled={busy} aria-describedby="count" />
      <div id="count" className="subtle">{message.length.toLocaleString("vi-VN")} / 63.206 ký tự</div></div>

    <div className="field"><label htmlFor="link">Liên kết (không bắt buộc)</label>
      <input id="link" type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} disabled={published || busy} placeholder="https://example.com" /></div>

    {!published && <div className="field"><label htmlFor="schedule">Thời gian đăng {status === "draft" ? "(điền để lên lịch ngay khi lưu)" : ""}</label>
      <input id="schedule" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} disabled={busy} /></div>}

    <div role="alert">{error && <p className="error">{error}</p>}</div>
    <div className="actions">
      <button className="btn primary" type="submit" disabled={busy || !dirty || !message.trim()}>
        {busy ? "Đang lưu…" : published ? "Lưu thay đổi lên Facebook" : willSchedule ? "Lưu và lên lịch" : "Lưu thay đổi"}
      </button>
    </div>
  </form>;
}
