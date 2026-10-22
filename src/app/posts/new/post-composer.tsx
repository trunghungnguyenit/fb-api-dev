"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { FieldError, focusFirstInvalid, FormSummary, invalidProps, useFieldErrors } from "@/app/form-field";
import { useUnsavedGuard } from "@/app/use-unsaved-guard";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkLink, checkMessage, checkSchedule, MESSAGE_MAX, type FieldErrors } from "@/lib/field-errors";
import { messageFor } from "@/lib/errors";
import type { ClientMediaLimits, MediaKind } from "@/lib/media/limits";
import MediaPicker, { useMediaItems, type MediaItem } from "../media-picker";

type Page = { id: string; page_name: string };
type Notice = { kind: "success" | "error"; text: string; toList?: boolean } | null;

/** An image of the post being duplicated: the new post gets a copy of the entry, sharing the stored file. */
export type InitialImage = { id: string; kind: MediaKind; url: string; name: string; size: number | null };
type Initial = { pageId: string; message: string; linkUrl: string; images?: InitialImage[]; imagesNotice?: string };

const toItem = (image: InitialImage): MediaItem => ({
  key: image.id, kind: image.kind, mediaId: image.id, clone: true, previewUrl: image.url, name: image.name, size: image.size, status: "ready", progress: 1
});

export default function PostComposer({ pages, initial, limits }: { pages: Page[]; initial?: Initial; limits: ClientMediaLimits }) {
  const media = useMediaItems((initial?.images ?? []).map(toItem), limits);
  const [pageId, setPageId] = useState(initial?.pageId ?? pages[0]?.id ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl ?? "");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [busy, setBusy] = useState<"save" | "now" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const form = useFieldErrors();
  const formRef = useRef<HTMLFormElement>(null);
  // Anything typed or chosen and not saved yet: leaving the page asks first.
  useUnsavedGuard(Boolean(message.trim() || linkUrl.trim() || scheduleLocal || media.items.length));

  /** What is wrong with the form, field by field (empty when it can be sent). */
  function validate(publishNow: boolean): FieldErrors {
    const found: FieldErrors = {};
    if (!pageId) found.page = "Chọn Fanpage để đăng bài.";
    const messageError = checkMessage(message, { required: media.refs.length === 0 });
    if (messageError) found.message = messageError;
    const linkError = media.items.length ? null : checkLink(linkUrl);
    if (linkError) found.link = linkError;
    if (!publishNow) {
      const scheduleError = checkSchedule(scheduleLocal, Date.now(), { required: false });
      if (scheduleError) found.schedule = scheduleError;
    }
    return found;
  }

  async function submit(publishNow: boolean) {
    const found = validate(publishNow);
    if (Object.keys(found).length) { form.setErrors(found); setNotice(null); focusFirstInvalid(formRef.current); return; }
    form.setErrors({});
    setBusy(publishNow ? "now" : "save"); setNotice(null);
    try {
      const scheduledAt = publishNow ? "" : scheduleLocal ? new Date(scheduleLocal).toISOString() : "";
      const result = await callApi("/api/posts", {
        method: "POST", body: { pageId, message, linkUrl: media.refs.length ? "" : linkUrl, scheduledAt, publishNow, media: media.refs }
      });
      // The post row now exists, so the form is always cleared: submitting again would create a
      // second post (and a second Facebook post if the first outcome was unclear).
      setMessage(""); setLinkUrl(""); setScheduleLocal(""); media.reset();

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
      // The server names the wrong fields (names as in this form): mark them, otherwise show the message above the buttons.
      const fields = fieldErrorsOf(e);
      if (fields) { form.setErrors(fields); setNotice(null); focusFirstInvalid(formRef.current); }
      else setNotice({ kind: "error", text: userMessage(e) });
    } finally { setBusy(null); }
  }

  const over = message.length > MESSAGE_MAX;
  return <form ref={formRef} noValidate onSubmit={e => { e.preventDefault(); void submit(false); }}>
    <div className="field"><label htmlFor="page">Fanpage</label>
      <select id="page" value={pageId} onChange={e => { setPageId(e.target.value); form.clear("page"); }} {...invalidProps("page", form.errors.page)}>
        {pages.map(page => <option key={page.id} value={page.id}>{page.page_name}</option>)}
      </select>
      <FieldError id="page" message={form.errors.page} /></div>
    <div className="field"><label htmlFor="message">Nội dung</label>
      <textarea id="message" value={message} onChange={e => { setMessage(e.target.value); form.clear("message"); }} placeholder="Nhập nội dung bài viết..." {...invalidProps("message", form.errors.message, "count")} />
      <div id="count" className={`subtle${over ? " over" : ""}`}>{message.length.toLocaleString("vi-VN")} / {MESSAGE_MAX.toLocaleString("vi-VN")} ký tự</div>
      <FieldError id="message" message={form.errors.message} /></div>
    {initial?.imagesNotice && <p className="notice" role="note">{initial.imagesNotice}</p>}
    <MediaPicker state={media} limits={limits} disabled={busy !== null} />
    <div className="field"><label htmlFor="link">Liên kết (không bắt buộc)</label>
      <input id="link" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={media.items.length ? "" : linkUrl}
        onChange={e => { setLinkUrl(e.target.value); form.clear("link"); }} placeholder="https://example.com" disabled={media.items.length > 0}
        {...invalidProps("link", form.errors.link, media.items.length ? "link-help" : undefined)} />
      {media.items.length > 0 && <div id="link-help" className="subtle">Bài có ảnh hoặc video không đăng kèm liên kết.</div>}
      <FieldError id="link" message={form.errors.link} /></div>
    <div className="field"><label htmlFor="schedule">Thời gian đăng (giờ của bạn; để trống để lưu nháp)</label>
      <input id="schedule" type="datetime-local" value={scheduleLocal} onChange={e => { setScheduleLocal(e.target.value); form.clear("schedule"); }} {...invalidProps("schedule", form.errors.schedule)} />
      <FieldError id="schedule" message={form.errors.schedule} /></div>
    <div role={notice?.kind === "error" ? "alert" : "status"} aria-live="polite">
      {notice && <p className={notice.kind}>{notice.text}{notice.toList && <> <Link href="/posts">Xem danh sách bài viết</Link></>}</p>}
    </div>
    <FormSummary count={form.count} />
    <div className="actions sticky-actions">
      <button className="btn" type="submit" disabled={busy !== null || media.uploading}>{busy === "save" ? "Đang lưu..." : "Lưu nháp / lịch"}</button>
      <button className="btn primary" type="button" disabled={busy !== null || media.uploading} onClick={() => void submit(true)}>{busy === "now" ? "Đang đăng..." : "Đăng ngay"}</button>
    </div>
    {media.uploading && <p className="subtle" role="status">Đang tải tệp lên… hãy chờ xong rồi lưu bài.</p>}
    <p className="subtle">“Đăng ngay” đăng lên Fanpage ngay lập tức. Bài có lịch được đăng khi đến giờ.</p>
  </form>;
}

