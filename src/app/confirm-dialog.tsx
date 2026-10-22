"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

export type ConfirmOptions = {
  title: string;
  /** What will happen, in plain words. Line breaks are kept. */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger": the confirm button is red and the safe choice has the focus. */
  tone?: "danger" | "default";
};

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** Asks the user to confirm in a themed dialog: `if (!(await confirm({ title, message }))) return;`. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return confirm;
}

/** One modal <dialog> for the whole app (Esc closes it, focus stays inside, the page behind is inert). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const titleId = useId();
  const messageId = useId();

  const confirm = useCallback<Confirm>((next) => new Promise<boolean>((resolve) => {
    resolver.current?.(false); // a second question replaces the first, which counts as "no"
    resolver.current = resolve;
    setOptions(next);
  }), []);

  useEffect(() => { if (options && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [options]);

  function onClose() {
    const dialog = dialogRef.current;
    resolver.current?.(dialog?.returnValue === "ok");
    resolver.current = null;
    if (dialog) dialog.returnValue = "";
    setOptions(null);
  }

  const danger = options?.tone === "danger";
  return <ConfirmContext.Provider value={confirm}>
    {children}
    <dialog ref={dialogRef} className="dialog confirm-dialog" onClose={onClose} aria-labelledby={titleId} aria-describedby={options?.message ? messageId : undefined}
      onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
      {options && <form method="dialog">
        <div className="dialog-body">
          <h2 id={titleId}>{options.title}</h2>
          {options.message && <div id={messageId} className="confirm-message">{options.message}</div>}
          <div className="actions dialog-actions">
            <button className="btn" type="submit" value="cancel" autoFocus={danger}>{options.cancelLabel ?? "Hủy"}</button>
            <button className={`btn ${danger ? "danger solid" : "primary"}`} type="submit" value="ok" autoFocus={!danger}>{options.confirmLabel ?? "Đồng ý"}</button>
          </div>
        </div>
      </form>}
    </dialog>
  </ConfirmContext.Provider>;
}
