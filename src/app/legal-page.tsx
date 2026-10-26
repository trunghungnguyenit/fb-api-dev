import Link from "next/link";
import type { ReactNode } from "react";
import { env } from "@/lib/env";

/** The date both legal pages were last changed (change it with the text, and nothing else). */
export const LEGAL_UPDATED = "26/10/2026";

/** Who runs the app and how to reach them, from the settings OPERATOR_NAME and CONTACT_EMAIL (see .env.example). */
export function operator() {
  return { name: env.OPERATOR_NAME ?? "Page Publisher", email: env.CONTACT_EMAIL ?? null };
}

export function ContactLine() {
  const { name, email } = operator();
  return <>{name}{email ? <> — liên hệ: <a href={`mailto:${email}`}>{email}</a></> : <> — địa chỉ liên hệ chưa được khai báo (quản trị viên cần đặt CONTACT_EMAIL)</>}</>;
}

/** The frame of a public text page: title, date, the text, and the way to the other legal page and to sign in. */
export default function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return <main className="shell legal-shell">
    <article className="panel legal">
      <header>
        <p className="subtle"><Link href="/login">← Page Publisher</Link></p>
        <h1 className="brand">{title}</h1>
        <p className="subtle">Cập nhật lần cuối: {LEGAL_UPDATED}</p>
        <p>{intro}</p>
      </header>
      {children}
      <footer>
        <nav aria-label="Trang pháp lý" className="legal-links">
          <Link href="/privacy">Chính sách quyền riêng tư</Link>
          <Link href="/terms">Điều khoản sử dụng</Link>
          <Link href="/login">Đăng nhập</Link>
        </nav>
      </footer>
    </article>
  </main>;
}
