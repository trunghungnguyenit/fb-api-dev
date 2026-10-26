"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// Quick feedback after an action ("Đã lưu", "Không đăng được bài…"): a frosted-glass card in the bottom-right corner,
// above the notification bell, so it never covers the navigation bar or the data on the page. It goes away by itself after
// 5 seconds (a thin bar shows the time left). Hovering or focusing it pauses the countdown, and it can be closed with ×.
// Several can be stacked. Messages that need a decision (a connection to renew, a field to fix) stay inline: not toasts.

export const TOAST_MS = 5000;
/** How long the slide-out lasts before the card is removed (see .toast-out in neo.css). */
const LEAVE_MS = 200;
/** More than this at once and the oldest goes: a wall of cards would hide the page. */
const MAX_VISIBLE = 4;

export type ToastKind = "success" | "warning" | "error" | "info";
export type ToastInput = {
  kind: ToastKind;
  text: string;
  /** Extra lines under the text (for instance why some posts were skipped). */
  details?: string[];
  link?: { href: string; label: string };
};
type ToastItem = ToastInput & { id: number; /** bumped when the same toast is shown again, which restarts its countdown */ round: number };

type Show = (toast: ToastInput) => void;
const ToastContext = createContext<Show | null>(null);

/** `const toast = useToast(); toast({ kind: "success", text: "Đã lưu." })`. */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside <ToastProvider>");
  return show;
}

const sameToast = (a: ToastInput, b: ToastInput) =>
  a.kind === b.kind && a.text === b.text && a.link?.href === b.link?.href && (a.details ?? []).join("\n") === (b.details ?? []).join("\n");

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback<Show>((toast) => {
    setItems((current) => {
      // The same message again (a retry, or React running an effect twice in development) restarts the one on screen.
      const existing = current.find((item) => sameToast(item, toast));
      if (existing) return current.map((item) => (item === existing ? { ...item, round: item.round + 1 } : item));
      return [...current, { ...toast, id: nextId.current++, round: 0 }].slice(-MAX_VISIBLE);
    });
  }, []);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);

  return <ToastContext.Provider value={show}>
    {children}
    <div className="toast-stack" role="region" aria-label="Thông báo nhanh">
      {items.map((item) => <ToastCard key={item.id} item={item} onDone={dismiss} />)}
    </div>
  </ToastContext.Provider>;
}

function ToastCard({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(TOAST_MS); // what remains of the 5 seconds, kept while paused
  const started = useRef(0);

  // (Re)starts when shown again (round) and resumes after a pause with the time that was left.
  useEffect(() => { left.current = TOAST_MS; setLeaving(false); }, [item.round]);
  useEffect(() => {
    if (paused || leaving) return;
    started.current = Date.now();
    const timer = window.setTimeout(() => setLeaving(true), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started.current));
    };
  }, [paused, leaving, item.id, item.round]);
  // The slide-out is timed here, not with `animationend`: users who turn animations off would otherwise never see it end.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onDone(item.id), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, item.id, onDone]);

  return <ToastView
    item={item} paused={paused} leaving={leaving} onClose={() => setLeaving(true)}
    onPause={() => setPaused(true)} onResume={() => setPaused(false)}
  />;
}

const ICON_PROPS = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;
function KindIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case "success": return <svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></svg>;
    case "warning": return <svg {...ICON_PROPS}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17.5h0" /></svg>;
    case "error": return <svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
    default: return <svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h0" /></svg>;
  }
}

/** The look of one toast (no timers): a glass card with a glowing edge in the colour of its kind. Errors and warnings are announced at once. */
export function ToastView({ item, paused = false, leaving = false, onClose, onPause, onResume }: {
  item: ToastInput & { round?: number }; paused?: boolean; leaving?: boolean;
  onClose?: () => void; onPause?: () => void; onResume?: () => void;
}) {
  return <div
    className={`toast toast-${item.kind}${leaving ? " toast-out" : ""}${paused ? " is-paused" : ""}`}
    role={item.kind === "error" || item.kind === "warning" ? "alert" : "status"}
    onMouseEnter={onPause} onMouseLeave={onResume} onFocus={onPause} onBlur={onResume}
  >
    <span className="toast-icon"><KindIcon kind={item.kind} /></span>
    <div className="toast-body">
      <div>{item.text}</div>
      {item.details?.map((line) => <div key={line} className="toast-detail">{line}</div>)}
      {item.link && <a href={item.link.href}>{item.link.label}</a>}
    </div>
    <button type="button" className="toast-close" aria-label="Đóng thông báo" onClick={onClose}>×</button>
    {/* Keyed by round so showing the same message again restarts the bar, like the countdown. */}
    <span key={item.round ?? 0} className="toast-progress" aria-hidden="true" />
  </div>;
}

/**
 * Shows a toast when it appears on screen and renders nothing itself: the drop-in replacement for an inline
 * `<p className="success">` / `<p className="error">`, in server and client components alike.
 */
export function Toast({ kind, text, details, link }: ToastInput): ReactNode {
  const show = useToast();
  const detailsKey = (details ?? []).join("\n");
  useEffect(() => {
    show({ kind, text, details: detailsKey ? detailsKey.split("\n") : undefined, link: link ? { href: link.href, label: link.label } : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `link` is compared by its parts below
  }, [show, kind, text, detailsKey, link?.href, link?.label]);
  return null;
}
