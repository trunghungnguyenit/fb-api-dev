"use client";

import { useState } from "react";
import { useConfirm } from "@/app/confirm-dialog";
import { FieldError, focusFirstInvalid, invalidProps } from "@/app/form-field";
import { ApiFailure, callApi, fieldErrorsOf, userMessage } from "@/lib/client-api";
import { checkReply, REPLY_MAX } from "@/lib/field-errors";
import { formatDateTime } from "@/lib/labels";
import type { CommentView } from "@/lib/meta/comments";

// Comments of a published post, read from Facebook when asked for and shown on the spot: nothing is kept.
// The Fanpage can reply, hide / show and delete comments here. Everything is also checked by the server.

type Kind = "app" | "feed";
type Page = { comments: CommentView[]; next: string | null; total: number | null; access: { read: boolean; manage: boolean } };
type Problem = { message: string; reconnect: boolean };
type Replies = { open: boolean; loading: boolean; items: CommentView[]; next: string | null };

const NEEDS_RECONNECT = new Set(["COMMENTS_SCOPES_MISSING", "COMMENTS_PERMISSION_DENIED"]);

function problemOf(e: unknown): Problem {
  return { message: userMessage(e), reconnect: e instanceof ApiFailure && e.code !== null && NEEDS_RECONNECT.has(e.code) };
}

export default function CommentsPanel({ kind, postId }: { kind: Kind; postId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [status, setStatus] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [replies, setReplies] = useState<Record<string, Replies>>({});
  const [replyingTo, setReplyingTo] = useState<string | null>(null); // comment id, or "post"
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // what is being sent, to disable repeated clicks

  const base = `/api/posts/${postId}/comments?kind=${kind}`;
  const actionQuery = `kind=${kind}&postId=${postId}`;

  async function load(after?: string) {
    setLoading(true); setProblem(null);
    try {
      const page = await callApi<Page>(after ? `${base}&after=${encodeURIComponent(after)}` : base, { method: "GET" });
      setComments((list) => (after ? [...list, ...page.comments] : page.comments));
      setNext(page.next); setTotal(page.total); setCanManage(page.access.manage);
      if (!after) setReplies({});
      setLoaded(true);
    } catch (e) {
      setProblem(problemOf(e));
    } finally { setLoading(false); }
  }

  async function loadReplies(id: string, more = false) {
    const current = replies[id];
    setReplies((r) => ({ ...r, [id]: { open: true, loading: true, items: more ? current?.items ?? [] : [], next: more ? current?.next ?? null : null } }));
    try {
      const after = more ? current?.next : null;
      const page = await callApi<Page>(`${base}&parent=${id}${after ? `&after=${encodeURIComponent(after)}` : ""}`, { method: "GET" });
      setReplies((r) => ({ ...r, [id]: { open: true, loading: false, items: [...(more ? r[id]?.items ?? [] : []), ...page.comments], next: page.next } }));
    } catch (e) {
      setReplies((r) => ({ ...r, [id]: { open: true, loading: false, items: r[id]?.items ?? [], next: null } }));
      setProblem(problemOf(e));
    }
  }

  /** A comment that is no longer on Facebook: take it off the screen. */
  function dropLocal(id: string) {
    setComments((list) => list.filter((c) => c.id !== id));
    setReplies((r) => Object.fromEntries(Object.entries(r).map(([key, v]) => [key, { ...v, items: v.items.filter((c) => c.id !== id) }])));
  }

  const patchLocal = (id: string, change: Partial<CommentView>) => {
    const apply = (list: CommentView[]) => list.map((c) => (c.id === id ? { ...c, ...change } : c));
    setComments(apply);
    setReplies((r) => Object.fromEntries(Object.entries(r).map(([key, v]) => [key, { ...v, items: apply(v.items) }])));
  };

  async function send(replyTo: string | null) {
    const wrong = checkReply(draft);
    if (wrong) { setReplyError(wrong); focusFirstInvalid(); return; }
    setReplyError(null);
    setBusy(`reply:${replyTo ?? "post"}`); setProblem(null); setStatus("");
    try {
      await callApi(`/api/posts/${postId}/comments`, { method: "POST", body: { kind, message: draft, ...(replyTo ? { replyTo } : {}) } });
      setDraft(""); setReplyingTo(null); setStatus("Đã gửi.");
      if (replyTo) {
        patchLocal(replyTo, { replyCount: (findComment(replyTo)?.replyCount ?? 0) + 1 });
        await loadReplies(replyTo);
      } else await load();
    } catch (e) {
      // The server says what is wrong with the reply (message): show it under the box, not as a general problem.
      const fields = fieldErrorsOf(e);
      if (fields?.message) { setReplyError(fields.message); focusFirstInvalid(); } else setProblem(problemOf(e));
    }
    finally { setBusy(null); }
  }

  const findComment = (id: string) => comments.find((c) => c.id === id) ?? Object.values(replies).flatMap((r) => r.items).find((c) => c.id === id);

  async function toggleHidden(c: CommentView) {
    setBusy(`hide:${c.id}`); setProblem(null); setStatus("");
    try {
      await callApi(`/api/comments/${c.id}`, { method: "PATCH", body: { kind, postId, hidden: !c.isHidden } });
      patchLocal(c.id, { isHidden: !c.isHidden });
      setStatus(c.isHidden ? "Đã hiện lại bình luận." : "Đã ẩn bình luận.");
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "COMMENT_GONE") dropLocal(c.id);
      setProblem(problemOf(e));
    } finally { setBusy(null); }
  }

  async function remove(c: CommentView) {
    if (!(await confirm({ title: "Xóa bình luận này?", message: "Bình luận sẽ bị xóa khỏi Facebook và không thể hoàn tác.", confirmLabel: "Xóa bình luận", tone: "danger" }))) return;
    setBusy(`delete:${c.id}`); setProblem(null); setStatus("");
    try {
      await callApi(`/api/comments/${c.id}?${actionQuery}`, { method: "DELETE" });
      dropLocal(c.id); setStatus("Đã xóa bình luận.");
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "COMMENT_GONE") dropLocal(c.id);
      setProblem(problemOf(e));
    } finally { setBusy(null); }
  }

  function replyBox(replyTo: string | null) {
    const key = replyTo ?? "post";
    if (replyingTo !== key) return null;
    return <form className="comment-reply" noValidate onSubmit={(e) => { e.preventDefault(); void send(replyTo); }}>
      <label className="visually-hidden" htmlFor={`reply-${key}`}>Nội dung trả lời</label>
      <textarea id={`reply-${key}`} value={draft} onChange={(e) => { setDraft(e.target.value); setReplyError(null); }} rows={3}
        placeholder="Trả lời với tư cách Fanpage…" disabled={busy === `reply:${key}`} {...invalidProps(`reply-${key}`, replyError, `reply-${key}-count`)} />
      <div id={`reply-${key}-count`} className={`subtle${draft.length > REPLY_MAX ? " over" : ""}`}>{draft.length.toLocaleString("vi-VN")} / {REPLY_MAX.toLocaleString("vi-VN")} ký tự</div>
      <FieldError id={`reply-${key}`} message={replyError} />
      <div className="actions">
        <button className="btn primary" type="submit" disabled={busy !== null}>{busy === `reply:${key}` ? "Đang gửi…" : "Gửi"}</button>
        <button className="btn" type="button" onClick={() => { setReplyingTo(null); setDraft(""); setReplyError(null); }} disabled={busy !== null}>Hủy</button>
      </div>
    </form>;
  }

  function item(c: CommentView, isReply = false) {
    const r = replies[c.id];
    return <li key={c.id} className={`comment${c.isHidden ? " comment-hidden" : ""}`}>
      <div className="comment-head">
        <strong>{c.author ?? "Người dùng Facebook"}</strong>
        {c.createdTime && <span className="subtle"> · {formatDateTime(c.createdTime)}</span>}
        {c.isHidden && <span className="badge">Đã ẩn</span>}
      </div>
      {c.message ? <p className="comment-body">{c.message}</p> : <p className="subtle">(không có chữ)</p>}
      {c.attachment && <p className="subtle">Đính kèm: {c.attachment.type}{c.attachment.url && <> · <a href={c.attachment.url} target="_blank" rel="noopener noreferrer">mở</a></>}</p>}
      <div className="comment-actions">
        <span className="subtle">{c.likeCount ?? 0} thích</span>
        {!isReply && (c.replyCount ?? 0) > 0 && <button type="button" className="link-button" onClick={() => (r?.open ? setReplies((x) => ({ ...x, [c.id]: { ...r, open: false } })) : void loadReplies(c.id))}>
          {r?.open ? "Ẩn trả lời" : `Xem ${c.replyCount} trả lời`}</button>}
        {canManage && c.canReply && <button type="button" className="link-button" disabled={busy !== null} onClick={() => { setReplyingTo(c.id); setDraft(""); setReplyError(null); }}>Trả lời</button>}
        {canManage && c.canHide && <button type="button" className="link-button" disabled={busy !== null} onClick={() => void toggleHidden(c)}>{busy === `hide:${c.id}` ? "Đang xử lý…" : c.isHidden ? "Hiện lại" : "Ẩn"}</button>}
        {canManage && c.canRemove && <button type="button" className="link-button danger" disabled={busy !== null} onClick={() => void remove(c)}>{busy === `delete:${c.id}` ? "Đang xóa…" : "Xóa"}</button>}
      </div>
      {replyBox(c.id)}
      {r?.open && <div className="comment-replies">
        {r.loading && r.items.length === 0 && <p className="subtle">Đang tải trả lời…</p>}
        <ul className="comment-list">{r.items.map((x) => item(x, true))}</ul>
        {r.next && <button type="button" className="link-button" disabled={r.loading} onClick={() => void loadReplies(c.id, true)}>Xem thêm trả lời</button>}
      </div>}
    </li>;
  }

  return <div>
    {!loaded
      ? <div className="actions">
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>{loading ? "Đang tải…" : "Xem bình luận"}</button>
        </div>
      : <div className="actions">
          <button type="button" className="btn" onClick={() => void load()} disabled={loading || busy !== null}>{loading ? "Đang tải…" : "Làm mới"}</button>
          {canManage && <button type="button" className="btn" onClick={() => { setReplyingTo("post"); setDraft(""); setReplyError(null); }} disabled={busy !== null}>Bình luận với tư cách Fanpage</button>}
          <span className="subtle">{total !== null ? `${total.toLocaleString("vi-VN")} bình luận` : `${comments.length} bình luận`}</span>
        </div>}

    <div role="status" aria-live="polite">{status && <p className="success">{status}</p>}</div>
    <div role="alert">{problem && <p className="error">{problem.message}{problem.reconnect && <> <a href="/api/auth/facebook">Kết nối lại Facebook</a></>}</p>}</div>
    {loaded && !canManage && <p className="notice" role="note">Bạn chỉ có quyền xem bình luận. Để trả lời, ẩn hoặc xóa, hãy <a href="/api/auth/facebook">kết nối lại Facebook</a> và cấp quyền quản lý bình luận.</p>}

    {replyBox(null)}
    {loaded && (comments.length === 0
      ? <p className="subtle">Bài này chưa có bình luận nào.</p>
      : <ul className="comment-list">{comments.map((c) => item(c))}</ul>)}
    {loaded && next && <div className="actions"><button type="button" className="btn" onClick={() => void load(next)} disabled={loading}>{loading ? "Đang tải…" : "Xem thêm bình luận"}</button></div>}
    <p className="subtle">Bình luận được đọc trực tiếp từ Facebook mỗi lần bạn mở hoặc làm mới, và không được lưu trong ứng dụng.</p>
  </div>;
}
