"use client";

import { useRef, useState } from "react";
import { FieldError, focusFirstInvalid, FormSummary, invalidProps, useFieldErrors } from "@/app/form-field";
import { useUnsavedGuard } from "@/app/use-unsaved-guard";
import { callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkLink, checkMedia, checkMessage, checkSchedule, MESSAGE_MAX, type FieldErrors } from "@/lib/field-errors";
import { dateTimeLocalOrEmpty } from "@/lib/draft-storage";
import { formatDateTime } from "@/lib/labels";
import { KIND_INFO, kindOfContent } from "@/lib/post-kind";
import { messageFor } from "@/lib/errors";
import type { ClientMediaLimits, MediaKind } from "@/lib/media/limits";
import MediaPicker, { useMediaItems, type MediaItem } from "../media-picker";
import FormSection from "../form-section";
import PostKindPicker from "../post-kind-picker";
import PostPreview from "../post-preview";
import { DraftBanner, useLocalDraft } from "../use-local-draft";
import { usePostKind } from "../use-post-kind";
import { Toast } from "@/app/toast";

type Page = { id: string; page_name: string };
type Notice = { kind: "success" | "error"; text: string; toList?: boolean } | null;

/** An image of the post being duplicated: the new post gets a copy of the entry, sharing the stored file. */
export type InitialImage = { id: string; kind: MediaKind; url: string; name: string; size: number | null };
type Initial = { pageId: string; message: string; linkUrl: string; postType?: string; images?: InitialImage[]; imagesNotice?: string };

const MESSAGE_LABEL = { text: "Nội dung", link: "Nội dung", images: "Chú thích (không bắt buộc)", video: "Chú thích (không bắt buộc)", reel: "Chú thích (không bắt buộc)" } as const;
const MESSAGE_PLACEHOLDER = {
  text: "Nhập nội dung bài viết...", link: "Nhập nội dung đi kèm liên kết...", images: "Viết chú thích cho ảnh...",
  video: "Viết chú thích cho video...", reel: "Viết chú thích cho Reels..."
} as const;

const toItem = (image: InitialImage): MediaItem => ({
  key: image.id, kind: image.kind, mediaId: image.id, clone: true, previewUrl: image.url, name: image.name, size: image.size, status: "ready", progress: 1
});

export default function PostComposer({ pages, initial, limits }: { pages: Page[]; initial?: Initial; limits: ClientMediaLimits }) {
  const media = useMediaItems((initial?.images ?? []).map(toItem), limits);
  const form = useFieldErrors();
  // Which fields exist depends on the kind; what they hold survives switching (only files of another sort are dropped, after asking).
  const { kind, choose, mediaKind } = usePostKind(
    kindOfContent({ postType: initial?.postType, linkUrl: initial?.linkUrl, mediaKinds: (initial?.images ?? []).map((i) => i.kind) }),
    media, () => { form.clear("link"); form.clear("media"); }
  );
  const [pageId, setPageId] = useState(initial?.pageId ?? pages[0]?.id ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl ?? "");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [busy, setBusy] = useState<"save" | "now" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // What is typed is also kept in this browser, so a closed tab or a lost connection does not lose it (not for a duplicate of a post: that one starts from the post).
  const draft = useLocalDraft("new", { message, linkUrl, schedule: scheduleLocal }, { message: "", linkUrl: "", schedule: "" }, !initial);
  // Anything typed or chosen and not saved yet: leaving the page asks first.
  useUnsavedGuard(Boolean(message.trim() || (kind === "link" && linkUrl.trim()) || scheduleLocal || media.items.length));

  /** What is wrong with the form, field by field (empty when it can be sent). */
  function validate(publishNow: boolean): FieldErrors {
    const found: FieldErrors = {};
    if (!pageId) found.page = "Chọn Fanpage để đăng bài.";
    const messageError = checkMessage(message, { required: mediaKind === null });
    if (messageError) found.message = messageError;
    if (kind === "link") {
      const linkError = checkLink(linkUrl, { required: true });
      if (linkError) found.link = linkError;
    }
    if (kind === "images" || kind === "video" || kind === "reel") {
      const mediaError = checkMedia(kind, media.refs.length);
      if (mediaError) found.media = mediaError;
    }
    if (!publishNow) {
      const scheduleError = checkSchedule(scheduleLocal, Date.now(), { required: false });
      if (scheduleError) found.schedule = scheduleError;
    }
    return found;
  }

  async function submit(publishNow: boolean) {
    setAttempt((n) => n + 1);
    const found = validate(publishNow);
    if (Object.keys(found).length) { form.setErrors(found); setNotice(null); focusFirstInvalid(formRef.current); return; }
    form.setErrors({});
    setBusy(publishNow ? "now" : "save"); setNotice(null);
    try {
      const scheduledAt = publishNow ? "" : scheduleLocal ? new Date(scheduleLocal).toISOString() : "";
      const result = await callApi("/api/posts", {
        method: "POST", body: { pageId, message, linkUrl: kind === "link" ? linkUrl : "", scheduledAt, publishNow, media: mediaKind ? media.refs : [] }
      });
      // The post row now exists, so the form is always cleared: submitting again would create a
      // second post (and a second Facebook post if the first outcome was unclear).
      setMessage(""); setLinkUrl(""); setScheduleLocal(""); media.reset(); draft.clear();

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
  // With a file the text is only a caption: a short box that comes after the file and the schedule. Otherwise it is the post.
  const caption = mediaKind !== null;
  const messageField = <div className={`field${caption ? " caption-field" : ""}`}><label htmlFor="message">{MESSAGE_LABEL[kind]}</label>
      <textarea id="message" value={message} onChange={e => { setMessage(e.target.value); form.clear("message"); }} placeholder={MESSAGE_PLACEHOLDER[kind]} {...invalidProps("message", form.errors.message, "count")} />
      <div id="count" className={`subtle${over ? " over" : ""}`}>{message.length.toLocaleString("vi-VN")} / {MESSAGE_MAX.toLocaleString("vi-VN")} ký tự</div>
      <FieldError id="message" message={form.errors.message} /></div>;
  function restoreDraft() {
    const saved = draft.restore();
    if (!saved) return;
    setMessage((saved.message ?? "").slice(0, MESSAGE_MAX)); setLinkUrl(saved.linkUrl ?? ""); setScheduleLocal(dateTimeLocalOrEmpty(saved.schedule));
    if (saved.linkUrl && kind === "text") void choose("link"); // the link field only exists for a link post
  }
  return <form ref={formRef} noValidate onSubmit={e => { e.preventDefault(); void submit(false); }}>
    {draft.pending && <DraftBanner savedAt={draft.pending.savedAt} dirty={Boolean(message.trim() || linkUrl.trim() || scheduleLocal)} onRestore={restoreDraft} onDiscard={draft.discard} />}
    <FormSection title="Fanpage và loại bài" summary={`${pages.find((p) => p.id === pageId)?.page_name ?? ""} · ${KIND_INFO[kind].label}`} forceOpen={Boolean(form.errors.page)} attempt={attempt}>
      <div className="field"><label htmlFor="page">Fanpage</label>
        <select id="page" value={pageId} onChange={e => { setPageId(e.target.value); form.clear("page"); }} {...invalidProps("page", form.errors.page)}>
          {pages.map(page => <option key={page.id} value={page.id}>{page.page_name}</option>)}
        </select>
        <FieldError id="page" message={form.errors.page} /></div>
      <PostKindPicker value={kind} onChange={(next) => void choose(next)} disabled={busy !== null} />
    </FormSection>
    {!caption && messageField}
    {initial?.imagesNotice && <p className="notice" role="note">{initial.imagesNotice}</p>}
    {mediaKind && <MediaPicker state={media} limits={limits} kind={mediaKind} disabled={busy !== null} error={form.errors.media} />}
    {kind === "link" && <div className="field"><label htmlFor="link">Liên kết <span className="subtle">(bắt buộc)</span></label>
      <input id="link" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={linkUrl}
        onChange={e => { setLinkUrl(e.target.value); form.clear("link"); }} placeholder="https://example.com" {...invalidProps("link", form.errors.link)} />
      <FieldError id="link" message={form.errors.link} /></div>}
    <FormSection title="Thời gian đăng" summary={scheduleLocal ? formatDateTime(new Date(scheduleLocal).toISOString()) : "Lưu nháp (chưa lên lịch)"} forceOpen={Boolean(form.errors.schedule)} attempt={attempt}>
      <div className="field"><label htmlFor="schedule">Thời gian đăng (giờ của bạn; để trống để lưu nháp)</label>
        <input id="schedule" type="datetime-local" value={scheduleLocal} onChange={e => { setScheduleLocal(e.target.value); form.clear("schedule"); }} {...invalidProps("schedule", form.errors.schedule)} />
        <FieldError id="schedule" message={form.errors.schedule} /></div>
    </FormSection>
    {caption && messageField}
    <PostPreview pageName={pages.find((p) => p.id === pageId)?.page_name ?? ""} message={message} link={kind === "link" ? linkUrl : ""}
      media={media.items.filter((i) => i.status !== "error").map((i) => ({ kind: i.kind, url: i.previewUrl, name: i.name }))} />
    {notice && <Toast kind={notice.kind} text={notice.text} link={notice.toList ? { href: "/posts", label: "Xem danh sách bài viết" } : undefined} />}
    <FormSummary count={form.count} />
    <div className="actions sticky-actions">
      <button className="btn" type="submit" disabled={busy !== null || media.uploading}>{busy === "save" ? "Đang lưu..." : "Lưu nháp / lịch"}</button>
      <button className="btn primary" type="button" disabled={busy !== null || media.uploading} onClick={() => void submit(true)}>{busy === "now" ? "Đang đăng..." : "Đăng ngay"}</button>
    </div>
    {media.uploading && <p className="subtle" role="status">Đang tải tệp lên… hãy chờ xong rồi lưu bài.</p>}
    <p className="subtle">“Đăng ngay” đăng lên Fanpage ngay lập tức. Bài có lịch được đăng khi đến giờ.</p>
  </form>;
}

