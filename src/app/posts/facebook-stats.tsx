"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { messageFor, withRef } from "@/lib/errors";

type State =
  | { kind: "loading" }
  | { kind: "live"; reactions: number; comments: number; shares: number; permalinkUrl: string | null }
  | { kind: "deleted" }
  | { kind: "error"; text: string };

// Loaded after the page has rendered, so a slow Graph call never blocks the detail page. The same call
// syncs the post's state on the server (found missing -> marked deleted, live again -> restored).
export default function FacebookStats({ postId, fallbackUrl, markedDeleted }: { postId: string; fallbackUrl: string; markedDeleted: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/posts/${postId}/facebook`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setState({ kind: "error", text: withRef(typeof body?.error === "string" ? body.error : messageFor("UNEXPECTED"), body?.ref) });
        return;
      }
      if (body.state === "deleted") {
        setState({ kind: "deleted" });
        if (!markedDeleted) router.refresh();
        return;
      }
      setState({ kind: "live", reactions: body.reactions ?? 0, comments: body.comments ?? 0, shares: body.shares ?? 0, permalinkUrl: body.permalinkUrl ?? null });
      if (markedDeleted) router.refresh();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState({ kind: "error", text: messageFor("NETWORK") });
    }
  }, [postId, markedDeleted, router]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  return <div aria-live="polite">
    {state.kind === "loading" && <p className="subtle">Đang tải số liệu từ Facebook…</p>}
    {state.kind === "live" && <>
      <div className="stats-row">
        <div><div className="stat">{state.reactions.toLocaleString("vi-VN")}</div><div className="subtle">Lượt thích / cảm xúc</div></div>
        <div><div className="stat">{state.comments.toLocaleString("vi-VN")}</div><div className="subtle">Bình luận</div></div>
        <div><div className="stat">{state.shares.toLocaleString("vi-VN")}</div><div className="subtle">Lượt chia sẻ</div></div>
      </div>
      <p><a className="btn" href={state.permalinkUrl ?? fallbackUrl} target="_blank" rel="noopener noreferrer">Xem bài trên Facebook</a></p>
    </>}
    {state.kind === "deleted" && <p className="error" role="alert">{messageFor("FB_POST_GONE")}</p>}
    {state.kind === "error" && <>
      <p className="error" role="alert">Không tải được số liệu từ Facebook. {state.text}</p>
      <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>Thử lại</button>
    </>}
  </div>;
}
