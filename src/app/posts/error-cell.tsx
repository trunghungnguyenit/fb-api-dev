"use client";

import { useId, useState } from "react";
import { StatusIcon } from "@/app/icons";

const LONG = 70;

/** The "Lỗi" cell of a post: a pill, the reason cut to two lines, and (for a long reason) a button that opens it in place. Works with mouse, touch and keyboard. */
export default function ErrorCell({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = text.length > LONG;
  return <div className="error-cell">
    <span className="pill pill-error"><StatusIcon tone="error" />Có lỗi</span>
    <span id={id} className={open ? "error-full" : "error-clamp"} title={text}>{text}</span>
    {long && <button type="button" className="err-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>{open ? "Thu gọn" : "Xem đầy đủ"}</button>}
  </div>;
}
