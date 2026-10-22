"use client";

// Previews of private-bucket images come through short-lived signed URLs, which next/image would need configured.
/* eslint-disable @next/next/no-img-element */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { FieldError, focusFirstInvalid, FormSummary, invalidProps, useFieldErrors } from "@/app/form-field";
import { useUnsavedGuard } from "@/app/use-unsaved-guard";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkLink, checkMessage, checkNote, checkSchedule, MESSAGE_MAX, NOTE_MAX, type FieldErrors } from "@/lib/field-errors";
import type { ClientMediaLimits, MediaKind } from "@/lib/media/limits";
import MediaPicker, { useMediaItems, type MediaItem } from "../../media-picker";

type Page = { id: string; page_name: string; disabled: boolean };
export type EditorImage = { id: string; kind: MediaKind; url: string | null; name: string; size: number | null; purged: boolean };
type Props = {
  id: string;
  mode: "published" | "unpublished";
  status: string;
  ambiguous: boolean;
  initial: { pageId: string; message: string; linkUrl: string; scheduledAt: string | null; note: string };
  pages: Page[];
  images: EditorImage[];
  limits: ClientMediaLimits;
};

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const toItem = (image: EditorImage): MediaItem => ({
  key: image.id, kind: image.kind, mediaId: image.id, kept: true, previewUrl: image.url ?? "", name: image.name, size: image.size, status: "ready", progress: 1
});

export default function PostEditor({ id, mode, status, ambiguous, initial, pages, images, limits }: Props) {
  const router = useRouter();
  const published = mode === "published";
  const media = useMediaItems(published ? [] : images.filter((i) => !i.purged && i.url).map(toItem), limits);
  const initialImageIds = images.filter((i) => !i.purged && i.url).map((i) => i.id).join(",");
  // Images changed: different files, a different order, or a new upload. (Drafts and queued posts only.)
  const mediaChanged = !published && media.refs.map((r) => r.id).join(",") !== initialImageIds;
  const [pageId, setPageId] = useState(initial.pageId);
  const [message, setMessage] = useState(initial.message);
  const [linkUrl, setLinkUrl] = useState(initial.linkUrl);
  const [note, setNote] = useState(initial.note);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useFieldErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();

  // Browser-local time is only known on the client (the server renders in its own timezone).
  const initialWhen = initial.scheduledAt ? toLocalInput(initial.scheduledAt) : "";
  useEffect(() => setWhen(initialWhen), [initialWhen]);

  const dirty = mediaChanged || message !== initial.message || linkUrl !== initial.linkUrl || pageId !== initial.pageId || when !== initialWhen || note !== initial.note;
  useUnsavedGuard(dirty && !busy);
  const hasImages = media.items.length > 0 || (published && images.length > 0);

  /** What is wrong with the form, field by field (empty when it can be saved). */
  function validate(): FieldErrors {
    const found: FieldErrors = {};
    const messageError = checkMessage(message, { required: !hasImages });
    if (messageError) found.message = messageError;
    if (!published && !media.items.length) {
      const linkError = checkLink(linkUrl);
      if (linkError) found.link = linkError;
    }
    if (!published && when && when !== initialWhen) {
      const scheduleError = checkSchedule(when, Date.now(), { required: false });
      if (scheduleError) found.schedule = scheduleError;
    }
    const noteError = checkNote(note);
    if (noteError) found.note = noteError;
    return found;
  }

  async function save() {
    setError("");
    if (!dirty) { form.setErrors({}); setError("Chưa có thay đổi nào để lưu."); return; }
    const found = validate();
    if (Object.keys(found).length) { form.setErrors(found); focusFirstInvalid(formRef.current); return; }
    form.setErrors({});
    const body: Record<string, unknown> = { action: "edit" };
    if (message !== initial.message) body.message = message;
    if (note !== initial.note) body.note = note;
    if (!published) {
      // A post with images has no link: adding images clears the link that was there.
      if (media.refs.length ? initial.linkUrl !== "" : linkUrl !== initial.linkUrl) body.linkUrl = media.refs.length ? "" : linkUrl;
      if (mediaChanged) body.media = media.refs;
      if (pageId !== initial.pageId) body.pageId = pageId;
      if (when && when !== initialWhen) {
        body.scheduledAt = new Date(when).toISOString();
        if (ambiguous && !(await confirm({
          title: "Chưa rõ bài đã được đăng chưa",
          message: "Chưa rõ bài này đã được đăng lên Facebook hay chưa. Hãy kiểm tra Fanpage trước.\nVẫn muốn lên lịch đăng lại?",
          confirmLabel: "Vẫn lên lịch", cancelLabel: "Để tôi kiểm tra", tone: "danger"
        }))) return;
        if (ambiguous) body.force = true;
      }
    } else if (message !== initial.message && !(await confirm({
      title: "Sửa nội dung bài đã đăng?",
      message: "Facebook sẽ hiển thị nhãn “Đã chỉnh sửa” trên bài này và mọi người có thể xem lịch sử chỉnh sửa.",
      confirmLabel: "Lưu lên Facebook"
    }))) {
      return;
    }
    setBusy(true);
    try {
      await callApi(`/api/posts/${id}`, { method: "PATCH", body });
      router.push(`/posts/${id}`);
      router.refresh();
    } catch (e) {
      // The server names the wrong fields (names as in this form): mark them, otherwise show the message above the button.
      const fields = fieldErrorsOf(e);
      if (fields) { form.setErrors(fields); focusFirstInvalid(formRef.current); }
      else setError(userMessage(e));
      setBusy(false);
    }
  }

  const willSchedule = !published && Boolean(when) && when !== initialWhen && status !== "scheduled";

  const over = message.length > MESSAGE_MAX;
  return <form ref={formRef} noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {published && <p className="notice" role="note">
      Bài đã đăng lên Facebook nên <strong>chỉ sửa được nội dung chữ</strong>. Muốn đổi liên kết, Fanpage hoặc giờ đăng, hãy nhân bản bài rồi đăng lại (bài cũ sẽ được giữ nguyên).
    </p>}

    <div className="field"><label htmlFor="page">Fanpage</label>
      <select id="page" value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={published || busy}>
        {pages.map((p) => <option key={p.id} value={p.id} disabled={p.disabled && p.id !== initial.pageId}>{p.page_name}</option>)}
      </select></div>

    <div className="field"><label htmlFor="message">Nội dung</label>
      <textarea id="message" value={message} onChange={(e) => { setMessage(e.target.value); form.clear("message"); }} disabled={busy} {...invalidProps("message", form.errors.message, "count")} />
      <div id="count" className={`subtle${over ? " over" : ""}`}>{message.length.toLocaleString("vi-VN")} / {MESSAGE_MAX.toLocaleString("vi-VN")} ký tự</div>
      <FieldError id="message" message={form.errors.message} /></div>

    {published
      ? images.length > 0 && <div className="field"><span className="label">Ảnh / video của bài</span>
          <div className="media-gallery">{images.map((i) => i.url && !i.purged
            ? <figure key={i.id}>{i.kind === "image" ? <img src={i.url} alt={i.name} /> : <video className="post-video" src={i.url} controls preload="metadata" aria-label={i.name} />}</figure>
            : <div key={i.id} className="media-gone">Tệp đã được dọn khỏi hệ thống</div>)}</div>
          <div className="subtle">Ảnh và video của bài đã đăng không sửa được.</div></div>
      : <MediaPicker state={media} limits={limits} disabled={busy} />}

    <div className="field"><label htmlFor="link">Liên kết (không bắt buộc)</label>
      <input id="link" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={media.items.length ? "" : linkUrl}
        onChange={(e) => { setLinkUrl(e.target.value); form.clear("link"); }} disabled={published || busy || media.items.length > 0} placeholder="https://example.com"
        {...invalidProps("link", form.errors.link, media.items.length > 0 ? "link-help" : undefined)} />
      {media.items.length > 0 && <div id="link-help" className="subtle">Bài có ảnh hoặc video không đăng kèm liên kết.</div>}
      <FieldError id="link" message={form.errors.link} /></div>

    {!published && <div className="field"><label htmlFor="schedule">Thời gian đăng (giờ của bạn){status === "draft" ? " · điền để lên lịch ngay khi lưu" : ""}</label>
      <input id="schedule" type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); form.clear("schedule"); }} disabled={busy} {...invalidProps("schedule", form.errors.schedule)} />
      <FieldError id="schedule" message={form.errors.schedule} /></div>}

    <div className="field"><label htmlFor="note">Ghi chú nội bộ (không đăng lên Facebook)</label>
      <input id="note" type="text" value={note} onChange={(e) => { setNote(e.target.value); form.clear("note"); }} disabled={busy} placeholder="Ví dụ: chiến dịch tháng 10, người soạn…" {...invalidProps("note", form.errors.note, "note-count")} />
      <div id="note-count" className={`subtle${note.length > NOTE_MAX ? " over" : ""}`}>{note.length} / {NOTE_MAX} ký tự</div>
      <FieldError id="note" message={form.errors.note} /></div>

    <div role="alert">{error && <p className="error">{error}</p>}</div>
    <FormSummary count={form.count} />
    <div className="actions sticky-actions">
      <button className="btn primary" type="submit" disabled={busy || media.uploading}>
        {busy ? "Đang lưu…" : published && message !== initial.message ? "Lưu thay đổi lên Facebook" : willSchedule ? "Lưu và lên lịch" : "Lưu thay đổi"}
      </button>
    </div>
  </form>;
}
