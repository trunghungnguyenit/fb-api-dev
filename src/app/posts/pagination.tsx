import Link from "next/link";
import JumpForm from "./jump-form";

/** Page numbers to show: the first, the last and the current page with its neighbours; null = a gap ("…"). */
export function pageWindow(current: number, total: number): (number | null)[] {
  const wanted = [...new Set([1, current - 1, current, current + 1, total])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  wanted.forEach((n, i) => {
    if (i > 0 && n - (wanted[i - 1] as number) > 1) out.push(null);
    out.push(n);
  });
  return out;
}

type Props = {
  current: number;
  totalPages: number;
  /** Link to page p, keeping the active filters. */
  href: (p: number) => string;
  /** The jump form is a plain GET to `action` carrying these query parameters (the filters and the tab). */
  action: string;
  params: Record<string, string>;
};

/** Previous / numbers / jump-to-page (checked in the browser) / next, under the table. */
export default function Pagination({ current, totalPages, href, action, params }: Props) {
  if (totalPages <= 1) return null;
  return <nav className="neo-pager" aria-label="Phân trang">
    {current > 1 ? <Link className="page-btn" href={href(current - 1)} rel="prev">← Trước</Link> : <span className="page-btn is-disabled" aria-disabled="true">← Trước</span>}
    <ul className="page-list">
      {pageWindow(current, totalPages).map((n, i) => <li key={n ?? `gap-${i}`}>
        {n === null ? <span className="page-gap" aria-hidden="true">…</span>
          : <Link className="page-btn" href={href(n)} aria-current={n === current ? "page" : undefined} aria-label={`Trang ${n}`}>{n}</Link>}
      </li>)}
    </ul>
    <JumpForm current={current} totalPages={totalPages} action={action} params={params} />
    {current < totalPages ? <Link className="page-btn" href={href(current + 1)} rel="next">Sau →</Link> : <span className="page-btn is-disabled" aria-disabled="true">Sau →</span>}
  </nav>;
}
