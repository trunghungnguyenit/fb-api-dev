"use client";

import { useCallback, useEffect, useState } from "react";
import { messageFor, withRef } from "@/lib/errors";
import type { InsightsResult, MetricResult } from "@/lib/insights";
import { formatYmd, INSIGHTS_TIME_ZONE } from "@/lib/meta/insights";
import DailyValuesDialog from "./daily-values-dialog";
import InsightChart from "./insight-chart";

type Props = { pageId: string; range: string; since: string; until: string };
type State =
  | { kind: "loading" }
  | { kind: "ready"; result: InsightsResult }
  | { kind: "error"; text: string; code: string | null };

const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
/** Failures the user fixes by granting permission again. */
const NEEDS_RECONNECT = new Set(["INSIGHTS_SCOPES_MISSING", "INSIGHTS_PERMISSION_DENIED", "PAGE_PERMISSION_LOST"]);

/** The numbers, read from Facebook after the page has rendered so a slow Graph call never blocks it. */
export default function InsightsView({ pageId, range, since, until }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ kind: "loading" });
    const query = new URLSearchParams({ page: pageId, range });
    if (range === "custom") { query.set("since", since); query.set("until", until); }
    try {
      const response = await fetch(`/api/insights?${query}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Only text from our own catalog ever arrives here; anything else becomes the generic message.
        setState({ kind: "error", text: withRef(typeof body?.error === "string" ? body.error : messageFor("UNEXPECTED"), body?.ref), code: typeof body?.code === "string" ? body.code : null });
        return;
      }
      setState({ kind: "ready", result: body as InsightsResult });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState({ kind: "error", text: messageFor("NETWORK"), code: "NETWORK" });
    }
  }, [pageId, range, since, until]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  if (state.kind === "loading") return <div aria-busy="true" aria-live="polite">
    <p className="subtle" role="status">Đang tải số liệu từ Facebook…</p>
    <div className="insight-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="insight-card insight-skeleton" aria-hidden="true" />)}</div>
  </div>;

  if (state.kind === "error") return <div role="alert" className="insight-error">
    <p className="error">{state.text}</p>
    <div className="actions">
      <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>Thử lại</button>
      {state.code && NEEDS_RECONNECT.has(state.code) && <a className="btn primary" href="/api/auth/facebook">Kết nối lại Facebook</a>}
    </div>
  </div>;

  return <InsightsContent result={state.result} />;
}

/** The cards for one result (no fetching: the view above loads it). */
export function InsightsContent({ result }: { result: InsightsResult }) {
  const at = new Date(result.fetchedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: INSIGHTS_TIME_ZONE });
  return <div aria-live="polite">
    <p className="subtle insight-summary">
      <strong>{result.page.name}</strong> · {formatYmd(result.range.start)} – {formatYmd(result.range.end)} ({result.range.days} ngày)
      {result.previous
        ? <> · so với {formatYmd(result.previous.start)} – {formatYmd(result.previous.end)}</>
        : <> · chưa có kỳ trước để so sánh</>}
      {" "}· đọc lúc {at}
    </p>
    <div className="insight-grid">{result.metrics.map((metric) => <MetricCard key={metric.key} metric={metric} context={`${result.page.name} · ${formatYmd(result.range.start)} – ${formatYmd(result.range.end)}`} />)}</div>
    <p className="subtle form-hint">Facebook cập nhật số liệu khoảng một lần mỗi ngày, nên ngày gần nhất có thể chưa đủ. “Người xem duy nhất” là trung bình mỗi ngày vì không cộng dồn được qua các ngày.</p>
  </div>;
}

const TONE_WORD = { good: "tốt", bad: "xấu", flat: "" } as const;

function MetricCard({ metric, context }: { metric: MetricResult; context: string }) {
  const titleId = `insight-${metric.key}`;
  if (metric.state === "problem") {
    return <article className="insight-card insight-card-problem" aria-labelledby={titleId}>
      <h2 id={titleId}>{metric.label}</h2>
      <p className="insight-problem" role="note">
        <svg className="neo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17.5h0" />
        </svg>
        <span>{metric.message ?? messageFor(metric.code)}</span>
      </p>
      <p className="subtle insight-hint">{metric.hint}</p>
    </article>;
  }

  const series = metric.series ?? [];
  const change = metric.changePct ?? null;
  const unit = metric.aggregate === "average" ? `${metric.unit} / ngày` : metric.unit;
  return <article className="insight-card" aria-labelledby={titleId}>
    <h2 id={titleId}>{metric.label}</h2>
    <p className="insight-value">{number.format(metric.value ?? 0)} <span className="insight-unit">{unit}</span></p>
    {change !== null
      ? <p className={`insight-change insight-${metric.tone}`}>
          <span aria-hidden="true">{change > 0 ? "▲" : change < 0 ? "▼" : "■"}</span>{" "}
          {change === 0 ? "Không đổi" : `${change > 0 ? "Tăng" : "Giảm"} ${percent.format(Math.abs(change))}%`} so với kỳ trước
          {metric.previousValue !== null && metric.previousValue !== undefined && <span className="insight-before"> ({number.format(metric.previousValue)})</span>}
          {metric.tone && TONE_WORD[metric.tone] && <span className="visually-hidden"> — {TONE_WORD[metric.tone]}</span>}
        </p>
      : <p className="insight-change insight-flat">Chưa có số kỳ trước để so sánh</p>}
    {metric.delta !== null && metric.delta !== undefined && metric.aggregate === "last" && <p className="subtle insight-delta">
      {metric.delta === 0 ? "Không đổi trong kỳ" : `${metric.delta > 0 ? "Tăng" : "Giảm"} ${number.format(Math.abs(metric.delta))} ${metric.unit} trong kỳ`}
    </p>}
    <InsightChart label={metric.label} series={series} zeroBased={metric.aggregate !== "last"} />
    <p className="subtle insight-hint">{metric.hint}</p>
    <DailyValuesDialog label={metric.label} unit={unit} series={series} subtitle={context} previousSeries={metric.previousSeries ?? null} goodWhen={metric.goodWhen}
      summary={{
        value: `${number.format(metric.value ?? 0)} ${unit}`,
        previous: metric.previousValue !== null && metric.previousValue !== undefined ? `${number.format(metric.previousValue)} ${unit}` : null,
        change: change === null ? null : change === 0 ? "Không đổi" : `${change > 0 ? "Tăng" : "Giảm"} ${percent.format(Math.abs(change))}%`,
        tone: metric.tone ?? "flat"
      }} />
  </article>;
}
