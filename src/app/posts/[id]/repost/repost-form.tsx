"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { FieldError, focusFirstInvalid, FormSummary, invalidProps, useFieldErrors } from "@/app/form-field";
import { ApiFailure, callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkLink, checkMessage, checkPageSelection, checkSchedule, MESSAGE_MAX, type FieldErrors } from "@/lib/field-errors";
import { MAX_REPOST_PAGES, REPOST_MODE_INFO, type RepostMode } from "@/lib/repost";
import { kindOfPostType, mediaKindOf, type PostKind } from "@/lib/post-kind";
import PostKindPicker, { KindBadge } from "@/app/posts/post-kind-picker";
import { postErrorText, statusLabel } from "@/lib/labels";
import StatusPill, { postTone } from "@/app/status-pill";
import { Toast } from "@/app/toast";

type Page = { id: string; page_name: string };
type Props = {
  id: string;
  modes: RepostMode[];
  live: boolean;
  ambiguous: boolean;
  sourcePageId: string;
  /** The stored post_type of the original: a post with files keeps its kind, a text or link post can be either. */
  postType: string;
  initial: { message: string; linkUrl: string };
  pages: Page[];
  /** Images of the original: the re-post reuses them, so the caption may be empty and there is no link. */
  imageCount?: number;
};
type When = "now" | "later" | "draft";
type Result = {
  posts: { id: string; status: string; last_error_code: string | null; facebook_deleted_at: string | null }[];
  warnings: { code: string; message: string }[];
};

const WHEN_OPTIONS: { value: When; title: string; hint: string }[] = [
  { value: "now", title: "Đăng ngay", hint: "Lên Facebook ngay lập tức" },
  { value: "later", title: "Lên lịch", hint: "Chọn ngày và giờ đăng" },
  { value: "draft", title: "Lưu nháp", hint: "Xem lại rồi đăng sau" }
];

// Kinds a text or link original can be re-posted as (the files of the others are reused as they are, so their kind is fixed).
const TEXT_KINDS: readonly PostKind[] = ["text", "link"];

export default function RepostForm({ id, modes, live, ambiguous, sourcePageId, postType, initial, pages, imageCount = 0 }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<RepostMode>(modes[0]);
  const [message, setMessage] = useState(initial.message);
  const [linkUrl, setLinkUrl] = useState(initial.linkUrl);
  const sourceKind = kindOfPostType(postType);
  const hasFiles = imageCount > 0 || mediaKindOf(sourceKind) !== null;
  const [textKind, setTextKind] = useState<PostKind>(initial.linkUrl ? "link" : "text");
  const kind: PostKind = hasFiles ? sourceKind : textKind;
  // What is sent as the link: only a link post has one.
  const effectiveLink = kind === "link" ? linkUrl : "";
  const defaultPage = pages.some((p) => p.id === sourcePageId) ? sourcePageId : pages[0].id;
  const [selected, setSelected] = useState<string[]>([defaultPage]);
  const [when, setWhen] = useState<When>("now");
  const [whenLocal, setWhenLocal] = useState("");
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const form = useFieldErrors();
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();

  const isReplace = mode === "replace";
  const needsLiveConfirm = live && mode === "clone";
  const effectiveWhen: When = isReplace ? "now" : when;
  const pageIds = isReplace ? [sourcePageId] : mode === "same_row" ? [selected[0] ?? defaultPage] : selected;
  const pageName = (pageId: string) => pages.find((p) => p.id === pageId)?.page_name ?? "Fanpage";

  const togglePage = (pageId: string) => setSelected((prev) =>
    prev.includes(pageId) ? prev.filter((p) => p !== pageId) : prev.length >= MAX_REPOST_PAGES ? prev : [...prev, pageId]);

  /** What is wrong with the form, field by field (empty when it can be sent). */
  function validate(): FieldErrors {
    const found: FieldErrors = {};
    const messageError = checkMessage(message, { required: !hasFiles });
    if (messageError) found.message = messageError;
    if (kind === "link") {
      const linkError = checkLink(linkUrl, { required: true });
      if (linkError) found.link = linkError;
    }
    if (!isReplace && mode !== "same_row") {
      const pagesError = checkPageSelection(selected, MAX_REPOST_PAGES);
      if (pagesError) found.pages = pagesError;
    }
    if (effectiveWhen === "later") {
      const whenError = checkSchedule(whenLocal, Date.now(), { required: true });
      if (whenError) found.when = whenError;
    }
    if (needsLiveConfirm && !confirmLive) found.confirmLive = "Hãy tích ô xác nhận bên dưới nếu bạn vẫn muốn đăng bài trùng nội dung.";
    return found;
  }

  async function submit(deleteOldFirst = false) {
    setError("");
    if (!deleteOldFirst) {
      const found = validate();
      if (Object.keys(found).length) { form.setErrors(found); focusFirstInvalid(formRef.current); return; }
      form.setErrors({});
    }
    let whenValue = "now";
    if (effectiveWhen === "draft") whenValue = "draft";
    if (effectiveWhen === "later") whenValue = new Date(whenLocal).toISOString();
    if (ambiguous && !(await confirm({
      title: "Chưa rõ bài gốc đã được đăng chưa",
      message: "Chưa rõ bài gốc đã được đăng lên Facebook hay chưa. Hãy kiểm tra Fanpage trước.\nVẫn muốn đăng lại?",
      confirmLabel: "Vẫn đăng lại", cancelLabel: "Để tôi kiểm tra", tone: "danger"
    }))) return;
    if (isReplace && !deleteOldFirst && !(await confirm({
      title: "Thay thế bài trên Facebook?",
      message: "Bản mới sẽ được đăng trước. Nếu thành công, bài cũ sẽ bị XÓA khỏi Facebook cùng toàn bộ lượt thích, bình luận và chia sẻ, không thể khôi phục.",
      confirmLabel: "Đăng bản mới và xóa bài cũ", tone: "danger"
    }))) return;

    setBusy(true);
    try {
      const response = await callApi<Result>(`/api/posts/${id}/repost`, {
        method: "POST",
        body: { mode, message, linkUrl: effectiveLink, pageIds, when: whenValue, confirmLive: confirmLive || undefined, force: ambiguous || undefined, deleteOldFirst: deleteOldFirst || undefined }
      });
      const only = response.posts.length === 1 ? response.posts[0] : null;
      if (only && response.warnings.length === 0 && only.status !== "failed") {
        router.push(`/posts/${only.id}`);
        router.refresh();
        return;
      }
      setResult(response);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "REPLACE_NEEDS_DELETE_FIRST") {
        setBusy(false);
        const deleteFirst = await confirm({
          title: "Facebook từ chối vì trùng với bài cũ",
          message: "Xóa bài cũ trên Facebook (không thể khôi phục) rồi đăng bản mới?",
          confirmLabel: "Xóa bài cũ và đăng", tone: "danger"
        });
        if (deleteFirst) return await submit(true);
        return setError(e.message);
      }
      // The server names the wrong fields (names as in this form): mark them.
      const fields = fieldErrorsOf(e);
      if (fields) { form.setErrors(fields); focusFirstInvalid(formRef.current); return; }
      // A failed replace/publish still created a row the user can open and retry.
      const body = e instanceof ApiFailure ? (e.body as Partial<Result> | null) : null;
      if (body?.posts?.length) setResult({ posts: body.posts, warnings: [] });
      setError(userMessage(e));
    } finally { setBusy(false); }
  }

  if (result) return <div className="form-narrow" role="status">
    {error && <p className="error" role="alert">{error}</p>}
    {result.warnings.map((w) => <p key={w.code} className="error" role="alert">{w.message}</p>)}
    <div className="table-wrap"><table>
      <thead><tr><th scope="col">Bài</th><th scope="col">Trạng thái</th><th scope="col">Ghi chú</th></tr></thead>
      <tbody>{result.posts.map((p) => <tr key={p.id}>
        <td><Link href={`/posts/${p.id}`}>Mở chi tiết</Link></td>
        <td><StatusPill tone={postTone(p.status, Boolean(p.facebook_deleted_at))}>{statusLabel(p.status, Boolean(p.facebook_deleted_at))}</StatusPill></td>
        <td>{postErrorText(p.last_error_code) ?? "—"}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="actions" style={{ marginTop: 16 }}>
      <Link className="btn primary" href="/posts">Về danh sách bài viết</Link>
    </div>
  </div>;

  const label = effectiveWhen === "draft" ? "Lưu nháp" : effectiveWhen === "later" ? "Lên lịch đăng lại" : isReplace ? "Đăng bản mới và xóa bài cũ" : "Đăng lại ngay";
  const target = pageIds.length === 1 ? `“${pageName(pageIds[0])}”` : `${pageIds.length} Fanpage`;
  const whenText = effectiveWhen === "now" ? "đăng ngay" : effectiveWhen === "draft" ? "lưu nháp"
    : whenLocal ? `lên lịch lúc ${new Date(whenLocal).toLocaleString("vi-VN")}` : "lên lịch (chưa chọn giờ)";
  const summary = isReplace ? `Đăng bản mới lên ${target}, rồi xóa bài cũ trên Facebook.`
    : mode === "same_row" ? `Đưa lại bài này vào hàng đợi trên ${target} và ${whenText}.`
    : `Tạo ${pageIds.length} bài mới trên ${target} và ${whenText}.`;

  const firstPage = pageName(pageIds[0] ?? defaultPage);
  const morePages = Math.max(0, pageIds.length - 1);

  const over = message.length > MESSAGE_MAX;
  return <form ref={formRef} noValidate className="repost-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <div className="repost-main">
      <fieldset className="form-section">
        <legend>1. Cách đăng lại</legend>
        {modes.map((m) => <label key={m} className={`choice-card${mode === m ? " is-selected" : ""}`}>
          <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} disabled={busy} />
          <span className="choice-body">
            <span className="choice-title">{REPOST_MODE_INFO[m].label}</span>
            <span className="choice-hint">{REPOST_MODE_INFO[m].hint}</span>
          </span>
        </label>)}
        {needsLiveConfirm && <div className="notice warn" role="note">
          <strong>Bài gốc vẫn còn trên Facebook.</strong> Đăng lại sẽ tạo bài trùng nội dung trên Fanpage; Facebook có thể từ chối hoặc coi là spam.
          <label className="choice-inline">
            <input id="confirm-live" type="checkbox" checked={confirmLive} onChange={(e) => { setConfirmLive(e.target.checked); form.clear("confirmLive"); }} disabled={busy} {...invalidProps("confirm-live", form.errors.confirmLive)} />
            <span>Tôi hiểu, vẫn muốn đăng bài mới</span>
          </label>
          <FieldError id="confirm-live" message={form.errors.confirmLive} />
        </div>}
      </fieldset>

      <fieldset className="form-section">
        <legend>2. Fanpage</legend>
        {isReplace
          ? <p className="static-field"><strong>{pageName(sourcePageId)}</strong><span className="subtle"> · bản mới luôn đăng cùng Fanpage với bài cũ</span></p>
          : mode === "same_row"
            ? <div className="field"><label htmlFor="page" className="visually-hidden">Fanpage</label>
                <select id="page" value={pageIds[0]} onChange={(e) => setSelected([e.target.value])} disabled={busy}>
                  {pages.map((p) => <option key={p.id} value={p.id}>{p.page_name}</option>)}
                </select></div>
            : <>
                <div id="pages" className={`choice-grid${form.errors.pages ? " group-invalid" : ""}`} role="group" aria-label="Fanpage">
                  {pages.map((p, i) => <label key={p.id} className={`choice-chip${selected.includes(p.id) ? " is-selected" : ""}`}>
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => { togglePage(p.id); form.clear("pages"); }} disabled={busy} {...(i === 0 ? invalidProps("pages", form.errors.pages) : {})} />
                    <span>{p.page_name}</span>
                  </label>)}
                </div>
                <FieldError id="pages" message={form.errors.pages} />
                <p className="subtle form-hint">Chọn một hoặc nhiều Fanpage (tối đa {MAX_REPOST_PAGES}). Mỗi Fanpage tạo một bài riêng.</p>
              </>}
      </fieldset>

      <fieldset className="form-section">
        <legend>3. Nội dung</legend>
        {hasFiles
          ? <KindBadge kind={sourceKind} note="giữ nguyên như bài gốc" />
          : <PostKindPicker value={kind} onChange={(next) => { setTextKind(next); form.clear("link"); }} kinds={TEXT_KINDS} disabled={busy} />}
        {imageCount > 0 && <p className="notice" role="note">Bài này có {imageCount} {sourceKind === "images" ? "ảnh" : "video"}. Bài đăng lại dùng lại {imageCount > 1 ? "các tệp" : "tệp"} đó (không tải lên lại); bài có tệp không đăng kèm liên kết.</p>}
        <div className="field"><label htmlFor="message">{hasFiles ? "Chú thích (không bắt buộc)" : "Nội dung bài viết"}</label>
          <textarea id="message" value={message} onChange={(e) => { setMessage(e.target.value); form.clear("message"); }} disabled={busy} {...invalidProps("message", form.errors.message, "count")} />
          <div id="count" className={`subtle${over ? " over" : ""}`}>{message.length.toLocaleString("vi-VN")} / {MESSAGE_MAX.toLocaleString("vi-VN")} ký tự</div>
          <FieldError id="message" message={form.errors.message} /></div>
        {kind === "link" && <div className="field"><label htmlFor="link">Liên kết <span className="subtle">(bắt buộc)</span></label>
          <input id="link" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={linkUrl} onChange={(e) => { setLinkUrl(e.target.value); form.clear("link"); }} disabled={busy} placeholder="https://example.com" {...invalidProps("link", form.errors.link)} />
          <FieldError id="link" message={form.errors.link} /></div>}
      </fieldset>
    </div>

    <aside className="repost-side" aria-label="Thời điểm đăng và xem trước">
      <div className="side-card">
        <fieldset className="form-section">
          <legend>4. Thời điểm</legend>
          {isReplace
            ? <p className="static-field"><strong>Đăng ngay</strong><span className="subtle"> · kiểu Thay thế luôn đăng ngay để bài cũ không bị xóa quá sớm</span></p>
            : <>
                <div className="choice-grid three">
                  {WHEN_OPTIONS.map((o) => <label key={o.value} className={`choice-card compact${when === o.value ? " is-selected" : ""}`}>
                    <input type="radio" name="when" value={o.value} checked={when === o.value} onChange={() => setWhen(o.value)} disabled={busy} />
                    <span className="choice-body"><span className="choice-title">{o.title}</span><span className="choice-hint">{o.hint}</span></span>
                  </label>)}
                </div>
                {when === "later" && <div className="field"><label htmlFor="when-local">Ngày và giờ đăng</label>
                  <input id="when-local" type="datetime-local" value={whenLocal} onChange={(e) => { setWhenLocal(e.target.value); form.clear("when"); }} disabled={busy} {...invalidProps("when-local", form.errors.when)} />
                  <FieldError id="when-local" message={form.errors.when} /></div>}
              </>}
        </fieldset>

        {error && <Toast kind="error" text={error} />}
        <FormSummary count={form.count} />
        <div className="form-footer sticky-actions">
          <p className="summary" aria-live="polite">{summary}</p>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Đang xử lý…" : label}
          </button>
        </div>
      </div>

      <PostPreview pageName={firstPage} morePages={morePages} message={message} linkUrl={effectiveLink} />
    </aside>
  </form>;
}

/** Live preview of how the post will look (approximation of a Facebook Page post). Display only. */
function PostPreview({ pageName, morePages, message, linkUrl }: { pageName: string; morePages: number; message: string; linkUrl: string }) {
  let host = "";
  try { if (linkUrl) host = new URL(linkUrl).hostname.replace(/^www\./, ""); } catch { /* an incomplete URL while typing is fine */ }
  return <figure className="fb-preview" aria-label="Xem trước bài viết">
    <figcaption className="fb-preview-label">Xem trước</figcaption>
    <div className="fb-preview-head">
      <span className="fb-avatar" aria-hidden="true">{Array.from(pageName)[0]?.toUpperCase() ?? "F"}</span>
      <span>
        <strong>{pageName}</strong>{morePages > 0 && <span className="subtle"> và {morePages} Fanpage khác</span>}
        <span className="subtle fb-preview-meta">Vừa xong · Công khai</span>
      </span>
    </div>
    <p className="fb-preview-body">{message.trim() || "Nội dung bài viết sẽ hiện ở đây."}</p>
    {host && <div className="fb-preview-link"><span>{host.toUpperCase()}</span><span className="subtle">{linkUrl}</span></div>}
  </figure>;
}
