"use client";

import { useEffect, useId, useRef, useState } from "react";
import { compareDays, diffTone, formatYmd, type DayPoint } from "@/lib/meta/insights";

const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + number.format(Math.abs(n));

/** The whole period against the one before, as the card shows it (already worded: the dialog only prints it). */
export type DailySummary = { value: string; previous: string | null; change: string | null; tone: "good" | "bad" | "flat" };

type Props = {
  label: string; unit: string; series: readonly DayPoint[]; subtitle: string;
  /** The previous period of the same length, or null when Facebook has none to compare with. */
  previousSeries: readonly DayPoint[] | null; goodWhen: "up" | "down"; summary: DailySummary;
};

/** What is inside the dialog (no state: the component below opens and closes it). */
export function DailyValuesContent({ label, unit, series, subtitle, previousSeries, goodWhen, summary, titleId, subtitleId }: Props & { titleId: string; subtitleId: string }) {
  const known = series.filter((p) => p.value !== null);
  const rows = compareDays(series, previousSeries);
  const compare = previousSeries !== null;
  return <form method="dialog">
    <div className="dialog-body">
      <h2 id={titleId}>{label} theo ngày</h2>
      <p id={subtitleId} className="subtle daily-subtitle">{subtitle} · {known.length}/{series.length} ngày có số liệu</p>
      <p className="daily-summary">
        <span>Cả kỳ: <strong>{summary.value}</strong></span>
        {summary.previous !== null && <span>Kỳ trước: <strong>{summary.previous}</strong></span>}
        {summary.change !== null && <span className={`insight-change insight-${summary.tone}`}>{summary.change}</span>}
        {!compare && <span className="subtle">Chưa có kỳ trước để so sánh.</span>}
      </p>
      <div className="daily-scroll" tabIndex={0} role="region" aria-labelledby={titleId}>
        <table className="daily-table">
          <thead><tr>
            <th scope="col">Ngày</th>
            <th scope="col">{compare ? "Kỳ này" : `${label}${unit ? ` (${unit})` : ""}`}</th>
            {compare && <><th scope="col">Kỳ trước</th><th scope="col">Chênh lệch</th></>}
          </tr></thead>
          <tbody>{rows.map((r) => <tr key={r.date}>
            <td>{formatYmd(r.date)}</td>
            <td>{r.value === null ? "—" : number.format(r.value)}</td>
            {compare && <>
              <td>{r.previousValue === null ? "—" : number.format(r.previousValue)}{r.previousDate && <small className="daily-prev-date">{formatYmd(r.previousDate)}</small>}</td>
              <td>{r.diff === null ? "—" : <span className={`daily-diff daily-${diffTone(r.diff, goodWhen)}`}>
                <span aria-hidden="true">{r.diff > 0 ? "▲" : r.diff < 0 ? "▼" : "■"}</span> {signed(r.diff)}
                {r.percent !== null && <small> ({r.percent > 0 ? "+" : r.percent < 0 ? "−" : ""}{percentFormat.format(Math.abs(r.percent))}%)</small>}
                <span className="visually-hidden"> — {r.diff === 0 ? "không đổi" : r.diff > 0 ? "tăng" : "giảm"} so với cùng ngày kỳ trước</span>
              </span>}</td>
            </>}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="actions dialog-actions">
        <button className="btn primary" type="submit" autoFocus>Đóng</button>
      </div>
    </div>
  </form>;
}

/**
 * "Xem số liệu theo ngày" of an Insights card: the day-by-day numbers in a dialog of their own, so a long table never pushes
 * the cards around or covers the ones beside it. Esc, the close button or a click outside closes it, and focus goes back to the button.
 */
export default function DailyValuesDialog(props: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => { if (open && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [open]);

  return <>
    <button type="button" className="link-button insight-table-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>Xem số liệu theo ngày</button>
    <dialog ref={dialogRef} className={`dialog daily-dialog${props.previousSeries ? " daily-compare" : ""}`} onClose={() => setOpen(false)} aria-labelledby={titleId} aria-describedby={subtitleId}
      onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
      {open && <DailyValuesContent {...props} titleId={titleId} subtitleId={subtitleId} />}
    </dialog>
  </>;
}
