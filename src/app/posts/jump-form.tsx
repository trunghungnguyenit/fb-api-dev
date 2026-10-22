"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FieldError, invalidProps } from "@/app/form-field";
import { checkJumpPage } from "@/lib/field-errors";

/** "Đến trang": goes to a page number after checking it, and says what is wrong instead of silently clamping. */
export default function JumpForm({ current, totalPages, action, params }: { current: number; totalPages: number; action: string; params: Record<string, string> }) {
  const router = useRouter();
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = checkJumpPage(value, totalPages);
    if (!result.ok) { setError(result.message); return; }
    const query = new URLSearchParams(params);
    if (result.page > 1) query.set("p", String(result.page)); else query.delete("p");
    const qs = query.toString();
    router.push(qs ? `${action}?${qs}` : action);
  }

  return <form className="page-jump" onSubmit={submit} noValidate>
    <label htmlFor="jump-page">Đến trang</label>
    <input id="jump-page" type="text" inputMode="numeric" enterKeyHint="go" autoComplete="off" value={value}
      onChange={(e) => { setValue(e.target.value); setError(null); }} {...invalidProps("jump-page", error)} />
    <button className="page-btn" type="submit">Đi</button>
    <FieldError id="jump-page" message={error} />
  </form>;
}
