"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

/**
 * A group of fields of a long form. On a computer it is only a group, always open. On a phone its title is a button that folds the
 * group away (what is chosen stays in view as a one-line `summary`), so the form is short enough to see as a whole and the action
 * bar at the bottom is always in reach. `forceOpen` opens it again when one of its fields is wrong.
 */
export default function FormSection({ title, summary, defaultOpen = true, forceOpen = false, attempt = 0, children }: {
  title: string; summary?: ReactNode; defaultOpen?: boolean; forceOpen?: boolean; /** Counts the attempts to send the form: a section folded again by hand opens again on the next failed one. */ attempt?: number; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen, attempt]);
  return <section className="form-section" data-open={open}>
    <button type="button" className="section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
      <span className="section-title">{title}</span>
      {!open && summary && <span className="section-summary">{summary}</span>}
      <span className="section-chevron" aria-hidden="true">▾</span>
    </button>
    <div id={bodyId} className="section-body">{children}</div>
  </section>;
}
