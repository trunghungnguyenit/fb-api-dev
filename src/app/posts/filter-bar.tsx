"use client";

import { useId, useState, type ReactNode } from "react";
import { IconSliders } from "@/app/icons";

/**
 * The filters of a list. On a computer they are all in view as before. On a phone only the search box stays in view and the
 * rest (status, Fanpage...) fold behind a "Bộ lọc" button that says how many of them are on, so the list is not pushed below the
 * fold by a tall form. The fields stay in the form either way: searching keeps the filters that were set.
 */
export default function FilterBar({ active, children }: { active: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return <div className="filter-bar" data-open={open}>
    <button type="button" className="btn filter-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
      <IconSliders />Bộ lọc{active > 0 && <span className="filter-count" aria-label={`${active} bộ lọc đang bật`}>{active}</span>}
    </button>
    <div id={bodyId} className="filter-body">{children}</div>
  </div>;
}
