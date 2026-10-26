"use client";

import { useCallback, useEffect, useState } from "react";
import { messageFor, withRef } from "@/lib/errors";
import type { PostReactionsResult } from "@/lib/post-reactions";

type State =
  | { kind: "loading" }
  | { kind: "ready"; result: PostReactionsResult }
  | { kind: "error"; text: string; code: string | null };

const number = new Intl.NumberFormat("vi-VN");
/** Failures the user fixes by granting permission again. */
const NEEDS_RECONNECT = new Set(["REACTIONS_PERMISSION_DENIED", "PAGE_PERMISSION_LOST"]);
/** Not a fault: this post just has no reactions to read. */
const JUST_INFO = new Set(["REACTIONS_POST_UNAVAILABLE"]);

/** The post's reactions by kind, read from Facebook after the page has rendered so a slow Graph call never blocks it. */
export default function PostReactions({ kind, id }: { kind: "app" | "feed"; id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/posts/${id}/reactions?kind=${kind}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Only text from our own catalog ever arrives here; anything else becomes the generic message.
        setState({ kind: "error", text: withRef(typeof body?.error === "string" ? body.error : messageFor("UNEXPECTED"), body?.ref), code: typeof body?.code === "string" ? body.code : null });
        return;
      }
      setState({ kind: "ready", result: body as PostReactionsResult });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState({ kind: "error", text: messageFor("NETWORK"), code: "NETWORK" });
    }
  }, [id, kind]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  if (state.kind === "loading") return <p className="subtle" role="status" aria-live="polite">Đang tải cảm xúc của bài từ Facebook…</p>;

  if (state.kind === "error") {
    if (state.code && JUST_INFO.has(state.code)) return <p className="notice" role="note">{state.text}</p>;
    return <div role="alert" className="insight-error">
      <p className="error">{state.text}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>Thử lại</button>
        {state.code && NEEDS_RECONNECT.has(state.code) && <a className="btn primary" href="/api/auth/facebook">Kết nối lại Facebook</a>}
      </div>
    </div>;
  }

  return <PostReactionsContent result={state.result} />;
}

/** The list for one result (no fetching: the component above loads it). */
export function PostReactionsContent({ result }: { result: PostReactionsResult }) {
  const known = result.types.filter((t) => t.value !== null);
  const refused = result.types.filter((t) => t.value === null);
  const sum = known.reduce((n, t) => n + (t.value ?? 0), 0);
  const total = result.total ?? (known.length ? sum : null);
  const biggest = Math.max(0, ...known.map((t) => t.value ?? 0));

  return <div aria-live="polite">
    {total !== null && <p className="reaction-total">{total === 0 ? "Bài chưa có cảm xúc nào." : <>Tổng cộng <strong>{number.format(total)}</strong> cảm xúc.</>}</p>}
    {known.length > 0 && total !== 0 && <ul className="reaction-list">
      {known.map((t) => <li key={t.key}>
        <span>{t.label}</span>
        <span className="reaction-track" aria-hidden="true"><span className="reaction-fill" style={{ width: `${biggest ? Math.round(((t.value ?? 0) / biggest) * 100) : 0}%`, opacity: t.value ? 1 : 0 }} /></span>
        <strong>{number.format(t.value ?? 0)}</strong>
      </li>)}
    </ul>}
    {refused.length > 0 && <p className="notice" role="note">
      {refused.length === result.types.length
        ? "Facebook không trả số liệu cảm xúc theo loại cho bài này."
        : `Facebook không trả số liệu cho: ${refused.map((t) => t.label).join(", ")}. Các loại khác vẫn hiển thị bình thường.`}
    </p>}
  </div>;
}
