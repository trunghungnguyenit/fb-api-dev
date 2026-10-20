"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePostActions } from "./use-post-actions";

type Props = { id: string; status: string; lastErrorCode: string | null; canRepost: boolean; editable: boolean };
type MenuPosition = { top?: number; bottom?: number; right: number };

// Compact controls for one row of the posts list: "Chi tiết", one primary action, and a "⋯" menu with the rest.
export default function RowActions({ id, status, lastErrorCode, canRepost, editable }: Props) {
  const { busy, error, run } = usePostActions({ id, lastErrorCode });
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ right: 0 });
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const canPublish = status === "draft" || status === "failed";
  const canCancel = status === "draft" || status === "scheduled" || status === "failed";
  const primaryRepost = canRepost && !canPublish; // published / cancelled: re-posting IS the main action
  const hasMenu = editable || canCancel || (canRepost && canPublish) || status === "draft";

  // The menu is position:fixed so the table's scroll container never clips it; any scroll/resize closes it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); buttonRef.current?.focus(); } };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (open) return setOpen(false);
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const right = Math.max(8, window.innerWidth - r.right);
      // Open upwards when there is not enough room below (bottom rows of a long list).
      setPosition(r.bottom > window.innerHeight - 260 ? { bottom: window.innerHeight - r.top + 6, right } : { top: r.bottom + 6, right });
    }
    setScheduling(false);
    setOpen(true);
  }

  const disabled = busy !== null;
  return <div className="row-actions">
    <div className="row-actions-line">
      <Link className="btn small" href={`/posts/${id}`}>Chi tiết</Link>
      {canPublish && <button className="btn small primary" type="button" disabled={disabled} onClick={() => void run("publish")}>
        {busy === "publish" ? "Đang đăng…" : status === "failed" ? "Thử lại" : "Đăng ngay"}
      </button>}
      {primaryRepost && <Link className="btn small primary" href={`/posts/${id}/repost`}>Đăng lại</Link>}
      {hasMenu && <button ref={buttonRef} className="btn small icon" type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label="Thêm thao tác" disabled={disabled} onClick={toggle}>⋯</button>}
    </div>

    {open && <div ref={panelRef} className="row-menu" role="menu" style={position}>
      {editable && <Link role="menuitem" className="row-menu-item" href={`/posts/${id}/edit`}>Sửa bài</Link>}
      {canRepost && canPublish && <Link role="menuitem" className="row-menu-item" href={`/posts/${id}/repost`}>Đăng lại…</Link>}
      {status === "draft" && (scheduling
        ? <div className="row-menu-form">
            <input type="datetime-local" aria-label="Thời gian đăng" value={when} onChange={(e) => setWhen(e.target.value)} disabled={disabled} />
            <button className="btn small primary" type="button" disabled={disabled}
              onClick={async () => { if (await run("schedule", when)) setOpen(false); }}>
              {busy === "schedule" ? "Đang lưu…" : "Lưu lịch"}
            </button>
          </div>
        : <button role="menuitem" className="row-menu-item" type="button" onClick={() => setScheduling(true)}>Lên lịch…</button>)}
      {canCancel && <button role="menuitem" className="row-menu-item danger" type="button" disabled={disabled}
        onClick={async () => { if (await run("cancel")) setOpen(false); }}>
        {busy === "cancel" ? "Đang hủy…" : "Hủy bài"}
      </button>}
    </div>}

    {error && <p className="row-error" role="alert">{error}</p>}
  </div>;
}
