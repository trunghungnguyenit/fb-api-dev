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

/** "Xem thêm" (phones): the next page added below what is shown. `remaining` = how many are still hidden. */
export type MoreLink = { href: string; remaining: number; total: number };

type Props = {
  current: number;
  totalPages: number;
  /** Link to page p, keeping the active filters. */
  href: (p: number) => string;
  /** The jump form is a plain GET to `action` carrying these query parameters (the filters and the tab). */
  action: string;
  params: Record<string, string>;
  /** On a phone the page numbers give way to one "Xem thêm" button (the numbers stay on a computer). */
  more?: MoreLink;
};

/** Previous / numbers / jump-to-page (checked in the browser) / next, under the table. */
export default function Pagination({ current, totalPages, href, action, params, more }: Props) {
  if (totalPages <= 1) return null;
  return <>
    {more && <div className="pager-more">
      {more.remaining > 0
        ? <Link className="btn" href={more.href} scroll={false} rel="next">Xem thêm ({more.remaining.toLocaleString("vi-VN")} còn lại)</Link>
        : <p className="subtle">Đã hiện hết {more.total.toLocaleString("vi-VN")}.</p>}
    </div>}
    <nav className={`neo-pager${more ? " pager-numbers" : ""}`} aria-label="Phân trang">
    {current > 1 ? <Link className="page-btn" href={href(current - 1)} rel="prev">← Trước</Link> : <span className="page-btn is-disabled" aria-disabled="true">← Trước</span>}
    <ul className="page-list">
      {pageWindow(current, totalPages).map((n, i) => <li key={n ?? `gap-${i}`}>
        {n === null ? <span className="page-gap" aria-hidden="true">…</span>
          : <Link className="page-btn" href={href(n)} aria-current={n === current ? "page" : undefined} aria-label={`Trang ${n}`}>{n}</Link>}
      </li>)}
    </ul>
    <JumpForm current={current} totalPages={totalPages} action={action} params={params} />
    {current < totalPages ? <Link className="page-btn" href={href(current + 1)} rel="next">Sau →</Link> : <span className="page-btn is-disabled" aria-disabled="true">Sau →</span>}
  </nav>
  </>;
}
