"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { messageFor, withRef } from "@/lib/errors";

// Catches any uncaught render/server error so users never see a raw stack trace or backend message.
// `digest` is Next's hash of the server error; it matches the line in the server log.
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return <main className="shell"><section className="panel" role="alert">
    <h1 className="brand">Đã xảy ra lỗi</h1>
    <p className="error">{withRef(messageFor("UNEXPECTED"), error.digest?.slice(0, 10).toUpperCase())}</p>
    <div className="actions">
      {/* reset() alone only re-renders on the client; refresh() refetches the server component that failed. */}
      <button className="btn primary" type="button" onClick={() => startTransition(() => { router.refresh(); reset(); })}>Thử lại</button>
      <Link className="btn" href="/">Về trang chủ</Link>
    </div>
  </section></main>;
}
