"use client";

import "./globals.css";
import { messageFor, withRef } from "@/lib/errors";

// Last resort when the root layout itself fails. It replaces <html>, so it must render its own shell.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="vi"><body><main className="shell"><section className="panel" role="alert">
    <h1 className="brand">Đã xảy ra lỗi</h1>
    <p className="error">{withRef(messageFor("UNEXPECTED"), error.digest?.slice(0, 10).toUpperCase())}</p>
    <button className="btn primary" type="button" onClick={() => reset()}>Thử lại</button>
  </section></main></body></html>;
}
