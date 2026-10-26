"use client";

import { useState } from "react";
import { FieldError, invalidProps } from "@/app/form-field";
import { IconSliders } from "@/app/icons";
import type { FieldErrors } from "@/lib/field-errors";
import { MAX_RANGE_DAYS } from "@/lib/meta/insights";

type Props = {
  pages: { id: string; name: string }[];
  page: string;
  range: string;
  since: string;
  until: string;
  /** Today in Vietnam (YYYY-MM-DD): the latest day a custom range may end on. */
  today: string;
  /** What is wrong with the range in the address bar, per field (checked on the server). */
  errors: FieldErrors;
};

/** Fanpage and date range. A GET form: the choice lives in the address, so it can be shared and survives a reload. */
export default function InsightsFilters({ pages, page, range, since, until, today, errors }: Props) {
  const [choice, setChoice] = useState(range);
  return <form method="get" action="/insights" className="filters" role="search" noValidate>
    <div className="field"><label htmlFor="page">Fanpage</label>
      <select id="page" name="page" defaultValue={page}>
        {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></div>
    <div className="field"><label htmlFor="range">Khoảng ngày</label>
      <select id="range" name="range" value={choice} onChange={(e) => setChoice(e.target.value)} {...invalidProps("range", errors.range)}>
        <option value="7d">7 ngày qua</option>
        <option value="28d">28 ngày qua</option>
        <option value="90d">90 ngày qua</option>
        <option value="custom">Tùy chọn…</option>
      </select>
      <FieldError id="range" message={errors.range} /></div>
    {choice === "custom" && <>
      <div className="field"><label htmlFor="since">Từ ngày</label>
        <input id="since" name="since" type="date" defaultValue={since} max={today} {...invalidProps("since", errors.since)} />
        <FieldError id="since" message={errors.since} /></div>
      <div className="field"><label htmlFor="until">Đến ngày</label>
        <input id="until" name="until" type="date" defaultValue={until} max={today} {...invalidProps("until", errors.until, "range-help")} />
        <FieldError id="until" message={errors.until} /></div>
    </>}
    <div className="actions"><button className="btn" type="submit"><IconSliders />Xem</button></div>
    {choice === "custom" && <p id="range-help" className="subtle form-hint insight-range-help">Tối đa {MAX_RANGE_DAYS} ngày mỗi lần; Facebook giữ số liệu 2 năm gần nhất.</p>}
  </form>;
}
