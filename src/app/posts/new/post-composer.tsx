"use client";

import Link from "next/link";
import { useState } from "react";
import { callApi, userMessage } from "@/lib/client-api";
import { messageFor } from "@/lib/errors";

type Page = { id: string; page_name: string };
type Notice = { kind: "success" | "error"; text: string; toList?: boolean } | null;

type Initial = { pageId: string; message: string; linkUrl: string };

export default function PostComposer({ pages, initial }: { pages: Page[]; initial?: Initial }) {
  const [pageId, setPageId] = useState(initial?.pageId ?? pages[0]?.id ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl ?? "");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [busy, setBusy] = useState<"save" | "now" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function submit(publishNow: boolean) {
    setBusy(publishNow ? "now" : "save"); setNotice(null);
    try {
      const scheduledAt = publishNow ? "" : scheduleLocal ? new Date(scheduleLocal).toISOString() : "";
      const result = await callApi("/api/posts", {
        method: "POST", body: { pageId, message, linkUrl, scheduledAt, publishNow }
      });
      // The post row now exists, so the form is always cleared: submitting again would create a
      // second post (and a second Facebook post if the first outcome was unclear).
      setMessage(""); setLinkUrl(""); setScheduleLocal("");

      const post = result.post;
      if (publishNow && post?.status === "published") setNotice({ kind: "success", text: "Đã đăng lên Facebook." });
      else if (publishNow && post?.status === "failed") {
        const reason = messageFor(post.last_error_code, "PUBLISH_FAILED");
        setNotice({
          kind: "error", toList: true,
          text: post.last_error_code === "AMBIGUOUS" ? reason : `Đăng thất bại. ${reason} Bạn có thể thử lại ở danh sách bài viết.`
        });
      }
      else if (publishNow) setNotice({ kind: "success", text: "Đã đưa vào hàng đợi, sẽ được đăng trong lần chạy tiếp theo.", toList: true });
      else setNotice({ kind: "success", text: scheduledAt ? "Đã lưu lịch đăng." : "Đã lưu bản nháp.", toList: true });
    } catch (e) {
      setNotice({ kind: "error", text: userMessage(e) });
    } finally { setBusy(null); }
  }

  return <form onSubmit={e => { e.preventDefault(); void submit(false); }}>
    <div className="field"><label htmlFor="page">Fanpage</label><select id="page" value={pageId} onChange={e => setPageId(e.target.value)} required>
      {pages.map(page => <option key={page.id} value={page.id}>{page.page_name}</option>)}
    </select></div>
    <div className="field"><label htmlFor="message">Nội dung</label><textarea id="message" value={message} onChange={e => setMessage(e.target.value)} required maxLength={63206} placeholder="Nhập nội dung bài viết..." aria-describedby="count" />
      <div id="count" className="subtle">{message.length.toLocaleString("vi-VN")} / 63.206 ký tự</div></div>
    <div className="field"><label htmlFor="link">Liên kết (không bắt buộc)</label><input id="link" type="url" value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://example.com" /></div>
    <div className="field"><label htmlFor="schedule">Thời gian đăng (để trống để lưu nháp)</label><input id="schedule" type="datetime-local" value={scheduleLocal} onChange={e => setScheduleLocal(e.target.value)} /></div>
    <div role={notice?.kind === "error" ? "alert" : "status"} aria-live="polite">
      {notice && <p className={notice.kind}>{notice.text}{notice.toList && <> <Link href="/posts">Xem danh sách bài viết</Link></>}</p>}
    </div>
    <div className="actions">
      <button className="btn" type="submit" disabled={busy !== null}>{busy === "save" ? "Đang lưu..." : "Lưu nháp / lịch"}</button>
      <button className="btn primary" type="button" disabled={busy !== null || !message.trim()} onClick={() => void submit(true)}>{busy === "now" ? "Đang đăng..." : "Đăng ngay"}</button>
    </div>
    <p className="subtle">“Đăng ngay” đăng lên Fanpage ngay lập tức. Bài có lịch được đăng khi đến giờ.</p>
  </form>;
}

