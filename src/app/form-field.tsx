"use client";

import { useCallback, useState } from "react";
import type { FieldErrors } from "@/lib/field-errors";

/** The message under a field. It is an alert, has an id for aria-describedby, and an icon so colour is not the only cue. */
export function FieldError({ id, message }: { id: string; message?: string | null }) {
  if (!message) return null;
  return <p id={`${id}-error`} className="field-error" role="alert">
    <svg className="neo-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h0" />
    </svg>
    <span>{message}</span>
  </p>;
}

/** aria attributes of a field that may be wrong: marks it invalid and points at its message (and at `also`, e.g. a counter). */
export function invalidProps(id: string, message?: string | null, also?: string) {
  return {
    "aria-invalid": message ? (true as const) : undefined,
    "aria-describedby": [also, message ? `${id}-error` : null].filter(Boolean).join(" ") || undefined
  };
}

/** State of the per-field messages of one form. */
export function useFieldErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});
  /** Removes the message of a field as soon as the user edits it. */
  const clear = useCallback((name: string) => setErrors((prev) => {
    if (!(name in prev)) return prev;
    const next = { ...prev };
    delete next[name];
    return next;
  }), []);
  return { errors, setErrors, clear, count: Object.keys(errors).length };
}

/** After the messages are on screen, takes the keyboard (and, on a phone, the screen) to the first wrong field. */
export function focusFirstInvalid(root?: ParentNode | null) {
  requestAnimationFrame(() => {
    const el = (root ?? document).querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

/** One line above the submit button when a submit was refused: how many things to fix. */
export function FormSummary({ count }: { count: number }) {
  if (count === 0) return null;
  return <p className="form-summary" role="alert">Có {count} mục cần sửa. Hãy xem các ô được đánh dấu đỏ ở trên.</p>;
}
