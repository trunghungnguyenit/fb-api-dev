"use client";

// Previews of private-bucket images come through short-lived signed URLs, which next/image would need configured.
/* eslint-disable @next/next/no-img-element */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { FieldError, focusFirstInvalid, FormSummary, invalidProps, useFieldErrors } from "@/app/form-field";
import { useUnsavedGuard } from "@/app/use-unsaved-guard";
import FormSection from "../../form-section";
import PostPreview from "../../post-preview";
import { DraftBanner, useLocalDraft } from "../../use-local-draft";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkLink, checkMedia, checkMessage, checkNote, checkSchedule, MESSAGE_MAX, NOTE_MAX, type FieldErrors } from "@/lib/field-errors";
import { dateTimeLocalOrEmpty } from "@/lib/draft-storage";
import { formatDateTime } from "@/lib/labels";
import { KIND_INFO, kindOfPostType } from "@/lib/post-kind";
import type { ClientMediaLimits, MediaKind } from "@/lib/media/limits";
import MediaPicker, { useMediaItems, type MediaItem } from "../../media-picker";
import PostKindPicker, { KindBadge } from "../../post-kind-picker";
import { usePostKind } from "../../use-post-kind";
import { Toast } from "@/app/toast";

type Page = { id: string; page_name: string; disabled: boolean };
export type EditorImage = { id: string; kind: MediaKind; url: string | null; name: string; size: number | null; purged: boolean };
type Props = {
  id: string;
  mode: "published" | "unpublished";
  status: string;
  ambiguous: boolean;
  /** The stored post_type: it decides the kind the form opens with. */
  postType: string;
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

export default function PostEditor({ id, mode, status, ambiguous, postType, initial, pages, images, limits }: Props) {
  const router = useRouter();
  const published = mode === "published";
  const media = useMediaItems(published ? [] : images.filter((i) => !i.purged && i.url).map(toItem), limits);
  const initialImageIds = images.filter((i) => !i.purged && i.url).map((i) => i.id).join(",");
  const form = useFieldErrors();
  const initialKind = kindOfPostType(postType);
  // A published post keeps its kind; a draft, queued or failed one can become any of the five (what the fields hold is kept).
  const { kind, choose, mediaKind } = usePostKind(initialKind, media, () => { form.clear("link"); form.clear("media"); });
  // Images changed: different files, a different order, or a new upload. (Drafts and queued posts only.)
  const mediaChanged = !published && media.refs.map((r) => r.id).join(",") !== initialImageIds;
  const [pageId, setPageId] = useState(initial.pageId);
  const [message, setMessage] = useState(initial.message);
  const [linkUrl, setLinkUrl] = useState(initial.linkUrl);
  // What is sent as the link: only a link post has one.
  const effectiveLink = kind === "link" ? linkUrl : "";
  const [note, setNote] = useState(initial.note);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();

  // Browser-local time is only known on the client (the server renders in its own timezone).
  const initialWhen = initial.scheduledAt ? toLocalInput(initial.scheduledAt) : "";
  useEffect(() => setWhen(initialWhen), [initialWhen]);

  const dirty = mediaChanged || kind !== initialKind || message !== initial.message || (!published && effectiveLink !== initial.linkUrl) || pageId !== initial.pageId || when !== initialWhen || note !== initial.note;
  useUnsavedGuard(dirty && !busy);
  // What is typed is also kept in this browser (see use-local-draft.tsx): a closed tab or a lost connection does not lose it.
  const draft = useLocalDraft(
    `edit:${id}`, { message, linkUrl, note, when }, { message: initial.message, linkUrl: initial.linkUrl, note: initial.note, when: initialWhen }
  );
  function restoreDraft() {
    const saved = draft.restore();
    if (!saved) return;
    setMessage((saved.message ?? initial.message).slice(0, MESSAGE_MAX)); setLinkUrl(saved.linkUrl ?? initial.linkUrl); setNote((saved.note ?? initial.note).slice(0, NOTE_MAX)); setWhen(saved.when === undefined ? initialWhen : dateTimeLocalOrEmpty(saved.when));
  }
  const hasImages = published ? images.length > 0 : mediaKind !== null;

  /** What is wrong with the form, field by field (empty when it can be saved). */
  function validate(): FieldErrors {
    const found: FieldErrors = {};
    const messageError = checkMessage(message, { required: !hasImages });
    if (messageError) found.message = messageError;
    if (!published && kind === "link") {
      const linkError = checkLink(linkUrl, { required: true });
      if (linkError) found.link = linkError;
    }
    if (!published && (kind === "images" || kind === "video" || kind === "reel")) {
      const mediaError = checkMedia(kind, media.refs.length);
      if (mediaError) found.media = mediaError;
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
    setAttempt((n) => n + 1);
    setError("");
    if (!dirty) { form.setErrors({}); setError("Chưa có thay đổi nào để lưu."); return; }
    const found = validate();
    if (Object.keys(found).length) { form.setErrors(found); focusFirstInvalid(formRef.current); return; }
    form.setErrors({});
    const body: Record<string, unknown> = { action: "edit" };
    if (message !== initial.message) body.message = message;
    if (note !== initial.note) body.note = note;
    if (!published) {
      // Only a link post has a link: any other kind clears the one that was there.
      if (effectiveLink !== initial.linkUrl) body.linkUrl = effectiveLink;
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
      draft.clear();
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
  // A post with a file (not yet published): the text is only a caption, a short box after the file and the schedule.
  const movedCaption = !published && mediaKind !== null;
  const messageField = <div className={`field${movedCaption ? " caption-field" : ""}`}><label htmlFor="message">{hasImages ? "Chú thích (không bắt buộc)" : "Nội dung"}</label>
      <textarea id="message" value={message} onChange={(e) => { setMessage(e.target.value); form.clear("message"); }} disabled={busy} {...invalidProps("message", form.errors.message, "count")} />
      <div id="count" className={`subtle${over ? " over" : ""}`}>{message.length.toLocaleString("vi-VN")} / {MESSAGE_MAX.toLocaleString("vi-VN")} ký tự</div>
      <FieldError id="message" message={form.errors.message} /></div>;
  return <form ref={formRef} noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {draft.pending && <DraftBanner savedAt={draft.pending.savedAt} dirty={dirty} onRestore={restoreDraft} onDiscard={draft.discard} />}
    {published && <p className="notice" role="note">
      Bài đã đăng lên Facebook nên <strong>chỉ sửa được nội dung chữ</strong>. Muốn đổi liên kết, Fanpage hoặc giờ đăng, hãy nhân bản bài rồi đăng lại (bài cũ sẽ được giữ nguyên).
    </p>}

    <FormSection title="Fanpage và loại bài" summary={`${pages.find((p) => p.id === pageId)?.page_name ?? ""} · ${KIND_INFO[published ? initialKind : kind].label}`}>
      <div className="field"><label htmlFor="page">Fanpage</label>
        <select id="page" value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={published || busy}>
          {pages.map((p) => <option key={p.id} value={p.id} disabled={p.disabled && p.id !== initial.pageId}>{p.page_name}</option>)}
        </select></div>

      {published
        ? <KindBadge kind={initialKind} note="không đổi được sau khi đã đăng" />
        : <PostKindPicker value={kind} onChange={(next) => void choose(next)} disabled={busy} />}
    </FormSection>

    {!movedCaption && messageField}

    {published
      ? images.length > 0 && <div className="field"><span className="label">{initialKind === "images" ? "Ảnh của bài" : "Video của bài"}</span>
          <div className="media-gallery">{images.map((i) => i.url && !i.purged
            ? <figure key={i.id}>{i.kind === "image" ? <img src={i.url} alt={i.name} /> : <video className="post-video" src={i.url} controls preload="metadata" aria-label={i.name} />}</figure>
            : <div key={i.id} className="media-gone">Tệp đã được dọn khỏi hệ thống</div>)}</div>
          <div className="subtle">Tệp của bài đã đăng không sửa được.</div></div>
      : mediaKind && <MediaPicker state={media} limits={limits} kind={mediaKind} disabled={busy} error={form.errors.media} />}

    {(published ? initialKind === "link" : kind === "link") && <div className="field"><label htmlFor="link">Liên kết{!published && <> <span className="subtle">(bắt buộc)</span></>}</label>
      <input id="link" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={linkUrl}
        onChange={(e) => { setLinkUrl(e.target.value); form.clear("link"); }} disabled={published || busy} placeholder="https://example.com"
        {...invalidProps("link", form.errors.link)} />
      <FieldError id="link" message={form.errors.link} /></div>}

    {!published && <FormSection title="Thời gian đăng" summary={when ? formatDateTime(new Date(when).toISOString()) : "Chưa lên lịch"} forceOpen={Boolean(form.errors.schedule)} attempt={attempt}>
      <div className="field"><label htmlFor="schedule">Thời gian đăng (giờ của bạn){status === "draft" ? " · điền để lên lịch ngay khi lưu" : ""}</label>
        <input id="schedule" type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); form.clear("schedule"); }} disabled={busy} {...invalidProps("schedule", form.errors.schedule)} />
        <FieldError id="schedule" message={form.errors.schedule} /></div>
    </FormSection>}

    {movedCaption && messageField}

    <div className="field"><label htmlFor="note">Ghi chú nội bộ (không đăng lên Facebook)</label>
      <input id="note" type="text" value={note} onChange={(e) => { setNote(e.target.value); form.clear("note"); }} disabled={busy} placeholder="Ví dụ: chiến dịch tháng 10, người soạn…" {...invalidProps("note", form.errors.note, "note-count")} />
      <div id="note-count" className={`subtle${note.length > NOTE_MAX ? " over" : ""}`}>{note.length} / {NOTE_MAX} ký tự</div>
      <FieldError id="note" message={form.errors.note} /></div>

    <PostPreview pageName={pages.find((p) => p.id === pageId)?.page_name ?? ""} message={message} link={(published ? initialKind === "link" : kind === "link") ? linkUrl : ""}
      media={published ? images.filter((i) => i.url && !i.purged).map((i) => ({ kind: i.kind, url: i.url as string, name: i.name })) : media.items.filter((i) => i.status !== "error").map((i) => ({ kind: i.kind, url: i.previewUrl, name: i.name }))} />

    {error && <Toast kind="error" text={error} />}
    <FormSummary count={form.count} />
    <div className="actions sticky-actions">
      <button className="btn primary" type="submit" disabled={busy || media.uploading}>
        {busy ? "Đang lưu…" : published && message !== initial.message ? "Lưu thay đổi lên Facebook" : willSchedule ? "Lưu và lên lịch" : "Lưu thay đổi"}
      </button>
    </div>
  </form>;
}
