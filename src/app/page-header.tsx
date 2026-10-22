import type { ReactNode } from "react";

/** Title block of a page, with that page's own actions on the right. Site-wide navigation lives in app-nav.tsx. */
export default function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return <header className="header neo-header">
    <div><h1 className="brand">{title}</h1>{subtitle && <div className="subtle">{subtitle}</div>}</div>
    {children && <div className="actions">{children}</div>}
  </header>;
}
