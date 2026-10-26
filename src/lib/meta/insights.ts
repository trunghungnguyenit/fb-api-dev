// Page Insights (GET /{page-id}/insights): which numbers the Insights page shows, the date ranges it accepts, and how
// Facebook's answer becomes something to draw. Pure module (safe for client and server): no network, no database.
//
// Meta retires Page metrics often (the "impressions" and "fans" families are gone, replaced by "media views" and
// "follows"), and its own documentation lags behind. So nothing here assumes a metric exists: the loader asks for
// each one and a refusal is reported for that metric alone (see lib/insights.ts).
import type { FieldErrors } from "@/lib/field-errors";

export type MetricKey = "mediaViews" | "viewers" | "followers" | "newFollows" | "unfollows" | "engagements";

/** How the daily values of a metric become the one number on its card. */
export type Aggregate = "sum" | "average" | "last";

export type MetricDef = {
  key: MetricKey;
  /** The metric's name in the Graph API. */
  graph: string;
  label: string;
  /** One sentence under the number: what it counts, and (when it is not a plain total) how the number is made. */
  hint: string;
  unit: string;
  aggregate: Aggregate;
  /** Which direction is good news (colours the change against the previous period). */
  goodWhen: "up" | "down";
};

export const INSIGHT_METRICS: readonly MetricDef[] = [
  { key: "mediaViews", graph: "page_media_view", label: "Lượt xem nội dung", unit: "lượt", aggregate: "sum", goodWhen: "up",
    hint: "Tổng số lần nội dung của Fanpage (bài, video, Reels, ảnh) được xem." },
  { key: "viewers", graph: "page_total_media_view_unique", label: "Người xem duy nhất", unit: "người", aggregate: "average", goodWhen: "up",
    hint: "Trung bình mỗi ngày. Một người xem nhiều ngày vẫn được tính lại mỗi ngày nên Facebook không cho cộng dồn." },
  { key: "followers", graph: "page_follows", label: "Người theo dõi", unit: "người", aggregate: "last", goodWhen: "up",
    hint: "Tổng số người theo dõi Fanpage vào ngày cuối của khoảng đã chọn." },
  { key: "newFollows", graph: "page_daily_follows", label: "Theo dõi mới", unit: "người", aggregate: "sum", goodWhen: "up",
    hint: "Số người bắt đầu theo dõi Fanpage trong khoảng ngày." },
  { key: "unfollows", graph: "page_daily_unfollows_unique", label: "Hủy theo dõi", unit: "người", aggregate: "sum", goodWhen: "down",
    hint: "Số người bỏ theo dõi Fanpage trong khoảng ngày." },
  { key: "engagements", graph: "page_post_engagements", label: "Tương tác với bài", unit: "lượt", aggregate: "sum", goodWhen: "up",
    hint: "Số lượt tương tác (cảm xúc, bình luận, chia sẻ, nhấp) với các bài của Fanpage." }
];

export const metricByGraphName = (name: string) => INSIGHT_METRICS.find((m) => m.graph === name);

// ---- Dates ------------------------------------------------------------------------------------------------------------
// A day is "YYYY-MM-DD". Facebook counts Page days in its own time zone and refreshes about once a day, so the app
// works in whole days and never in hours.

export type Ymd = string;
const DAY_MS = 86_400_000;
/** Most days Meta answers for in one request. */
export const MAX_RANGE_DAYS = 93;
/** How far back Meta keeps Page metrics. */
export const HISTORY_DAYS = 730;
export const INSIGHTS_TIME_ZONE = "Asia/Ho_Chi_Minh";

const ms = (d: Ymd) => Date.parse(`${d}T00:00:00Z`);
export const isYmd = (value: unknown): value is Ymd =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(ms(value)) && new Date(ms(value)).toISOString().slice(0, 10) === value;
export const addDays = (d: Ymd, n: number): Ymd => new Date(ms(d) + n * DAY_MS).toISOString().slice(0, 10);
/** Number of days from `a` to `b`, both included. */
export const daysInclusive = (a: Ymd, b: Ymd) => Math.round((ms(b) - ms(a)) / DAY_MS) + 1;
/** Today's date where the user is (Vietnam). */
export const todayVN = (now: Date): Ymd => now.toLocaleDateString("en-CA", { timeZone: INSIGHTS_TIME_ZONE });
/** 2026-10-25 -> 25/10/2026 */
export const formatYmd = (d: Ymd) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export type RangePreset = "7d" | "28d" | "90d" | "custom";
export type DateRange = { preset: RangePreset; start: Ymd; end: Ymd; days: number };

const PRESET_DAYS: Record<Exclude<RangePreset, "custom">, number> = { "7d": 7, "28d": 28, "90d": 90 };
export const DEFAULT_PRESET: RangePreset = "28d";

/**
 * The range the user asked for (query string values), or what is wrong with it, per field. Presets end YESTERDAY: today's
 * numbers are not in yet. A custom range may end today but not in the future, may span at most 93 days and must start
 * inside the two years Facebook keeps.
 */
export function resolveRange(
  input: { range?: string | null; since?: string | null; until?: string | null }, now: Date = new Date()
): { ok: true; range: DateRange } | { ok: false; errors: FieldErrors } {
  const today = todayVN(now);
  const preset = input.range || DEFAULT_PRESET;
  if (preset in PRESET_DAYS) {
    const days = PRESET_DAYS[preset as keyof typeof PRESET_DAYS];
    const end = addDays(today, -1);
    return { ok: true, range: { preset: preset as RangePreset, start: addDays(end, -(days - 1)), end, days } };
  }
  if (preset !== "custom") return { ok: false, errors: { range: "Khoảng ngày không hợp lệ. Hãy chọn 7, 28, 90 ngày hoặc “Tùy chọn”." } };

  const errors: FieldErrors = {};
  const since = input.since?.trim() ?? "";
  const until = input.until?.trim() ?? "";
  if (!since) errors.since = "Chọn ngày bắt đầu.";
  else if (!isYmd(since)) errors.since = "Ngày bắt đầu chưa đúng. Hãy chọn lại bằng bộ chọn ngày.";
  if (!until) errors.until = "Chọn ngày kết thúc.";
  else if (!isYmd(until)) errors.until = "Ngày kết thúc chưa đúng. Hãy chọn lại bằng bộ chọn ngày.";
  if (errors.since || errors.until) return { ok: false, errors };

  const earliest = addDays(today, -HISTORY_DAYS);
  if (since > until) errors.until = "Ngày kết thúc phải cùng ngày hoặc sau ngày bắt đầu.";
  else if (until > today) errors.until = "Không chọn được ngày trong tương lai.";
  else if (daysInclusive(since, until) > MAX_RANGE_DAYS) {
    errors.until = `Khoảng ngày tối đa ${MAX_RANGE_DAYS} ngày (bạn đang chọn ${daysInclusive(since, until)} ngày). Hãy chọn khoảng ngắn hơn.`;
  }
  if (!errors.since && since < earliest) errors.since = `Facebook chỉ giữ số liệu 2 năm gần nhất. Hãy chọn ngày từ ${formatYmd(earliest)}.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, range: { preset: "custom", start: since, end: until, days: daysInclusive(since, until) } };
}

/** The range of the same length that ends the day before `range` starts; null when it would reach past what Facebook keeps. */
export function previousRange(range: DateRange, now: Date = new Date()): DateRange | null {
  const end = addDays(range.start, -1);
  const start = addDays(end, -(range.days - 1));
  if (start < addDays(todayVN(now), -HISTORY_DAYS)) return null;
  return { preset: "custom", start, end, days: range.days };
}

/** `since` / `until` for the Graph call: `until` is the day AFTER the last day wanted. */
export const graphWindow = (range: DateRange) => ({ since: range.start, until: addDays(range.end, 1) });

// ---- Reading Facebook's answer ----------------------------------------------------------------------------------------

export type DayPoint = { date: Ymd; value: number | null };

/** A metric value is a number, or (for metrics with a breakdown) an object of numbers, which is summed. Anything else is "no value". */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object") {
    let total = 0;
    let found = false;
    for (const inner of Object.values(value)) {
      const n = numberOf(inner);
      if (n !== null) { total += n; found = true; }
    }
    return found ? total : null;
  }
  return null;
}

/** A value's `end_time` is the END of its day, so the day it belongs to is 24 hours earlier. */
export function dayOfEndTime(endTime: unknown): Ymd | null {
  if (typeof endTime !== "string") return null;
  const t = Date.parse(endTime);
  return Number.isNaN(t) ? null : new Date(t - DAY_MS).toISOString().slice(0, 10);
}

/** Facebook's body -> for each metric it answered, its daily values (sorted by day). Unusable entries are skipped. */
export function parseInsights(body: unknown): Map<string, DayPoint[]> {
  const out = new Map<string, DayPoint[]>();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const name = (entry as { name?: unknown })?.name;
    const values = (entry as { values?: unknown })?.values;
    if (typeof name !== "string" || !Array.isArray(values)) continue;
    const byDay = new Map<Ymd, number | null>();
    for (const v of values) {
      const date = dayOfEndTime((v as { end_time?: unknown })?.end_time);
      if (date) byDay.set(date, numberOf((v as { value?: unknown })?.value));
    }
    out.set(name, [...byDay].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)));
  }
  return out;
}

/** One entry per day of the range, in order: days Facebook said nothing about are `null`, days outside the range are dropped. */
export function fillDays(points: readonly DayPoint[], range: Pick<DateRange, "start" | "end">): DayPoint[] {
  const known = new Map(points.map((p) => [p.date, p.value]));
  const out: DayPoint[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push({ date: d, value: known.get(d) ?? null });
  return out;
}

// ---- Numbers for a card -----------------------------------------------------------------------------------------------

/** The number on a card: total, average per day, or the last known value. `null` when there is no value at all. */
export function mainValue(aggregate: Aggregate, series: readonly DayPoint[]): number | null {
  const values = series.map((p) => p.value).filter((v): v is number => v !== null);
  if (!values.length) return null;
  if (aggregate === "last") return values[values.length - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  return aggregate === "average" ? sum / values.length : sum;
}

/** Change against the previous period in percent; `null` when there is nothing to compare with (or it was 0). */
export function changePercent(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Whether a change is good news, bad news or neutral, for colouring. */
export function changeTone(percent: number | null, goodWhen: "up" | "down"): "good" | "bad" | "flat" {
  if (percent === null || Math.abs(percent) < 0.05) return "flat";
  return (percent > 0) === (goodWhen === "up") ? "good" : "bad";
}

/** One day of the range next to the day in the same place of the previous period (day 1 with day 1, day 2 with day 2...). */
export type DayComparison = {
  date: Ymd; value: number | null;
  /** The matching day of the previous period; null when there is no previous period. */
  previousDate: Ymd | null; previousValue: number | null;
  /** value - previousValue, only when both are known. */
  diff: number | null;
  /** The change in percent, only when both are known and the previous one is not zero. */
  percent: number | null;
};

/** The days of a range paired with the days of the same length before it. Without a previous period the pairs carry no comparison. */
export function compareDays(series: readonly DayPoint[], previous: readonly DayPoint[] | null): DayComparison[] {
  return series.map((day, i) => {
    const before = previous?.[i] ?? null;
    const known = day.value !== null && before?.value !== null && before?.value !== undefined;
    return {
      date: day.date, value: day.value,
      previousDate: before?.date ?? null, previousValue: before?.value ?? null,
      diff: known ? (day.value as number) - (before?.value as number) : null,
      percent: known ? changePercent(day.value, before?.value as number) : null
    };
  });
}

/** Good news, bad news or nothing for a plain difference (a day with 0 before it has no percent, but it did go up). */
export function diffTone(diff: number | null, goodWhen: "up" | "down"): "good" | "bad" | "flat" {
  if (diff === null || diff === 0) return "flat";
  return (diff > 0) === (goodWhen === "up") ? "good" : "bad";
}

// ---- Telling Facebook's refusals apart --------------------------------------------------------------------------------

export type MetricErrorKind = "unsupported" | "permission" | "failed";

/**
 * What a Graph error means for ONE metric. Code 100 naming a metric = Facebook no longer knows it (retired or renamed);
 * the permission codes mean the whole Page is off limits; any other answer is a failure of this metric only.
 * Dead tokens, rate limits and outages are not decided here: they stop the whole read (see lib/insights.ts).
 */
export function metricErrorKind(e: { code: string; subcode?: string; message: string }): MetricErrorKind {
  if (e.code === "100" && /metric/i.test(e.message)) return "unsupported";
  if (["10", "200", "283", "459"].includes(e.code) || (e.code === "100" && e.subcode === "33")) return "permission";
  return "failed";
}

// ---- Drawing -----------------------------------------------------------------------------------------------------------

export type ChartGeometry = {
  /** SVG path data of the line (one sub-path per run of days with values). */
  line: string;
  /** SVG path data of the filled area under the line (runs of two or more days). */
  area: string;
  /** Days with a value on their own (a run of one), to be drawn as dots. */
  dots: { x: number; y: number }[];
  /** The lowest and highest value of the DATA (not of the drawing scale, which is widened for a flat line). */
  min: number;
  max: number;
};

/** Plots daily values into a width x height box. Gaps (null) break the line instead of being drawn as zero. */
export function chartGeometry(
  values: readonly (number | null)[],
  opts: { width: number; height: number; padX?: number; padTop?: number; padBottom?: number; zeroBased?: boolean }
): ChartGeometry {
  const { width, height, padX = 4, padTop = 8, padBottom = 8, zeroBased = true } = opts;
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return { line: "", area: "", dots: [], min: 0, max: 0 };
  let min = zeroBased ? Math.min(0, ...known) : Math.min(...known);
  let max = Math.max(...known);
  if (max === min) { max = min + 1; if (!zeroBased) min -= 1; }
  const x = (i: number) => (values.length === 1 ? width / 2 : padX + (i * (width - 2 * padX)) / (values.length - 1));
  const y = (v: number) => padTop + ((max - v) * (height - padTop - padBottom)) / (max - min);
  const round = (n: number) => Math.round(n * 10) / 10;

  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) { if (current.length) runs.push(current); current = []; return; }
    current.push({ x: round(x(i)), y: round(y(v)) });
  });
  if (current.length) runs.push(current);

  const base = round(y(zeroBased ? 0 : min)); // the area is filled down to zero, or to the lowest value when the scale is not zero-based
  const line = runs.filter((r) => r.length > 1).map((r) => r.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ")).join(" ");
  const area = runs.filter((r) => r.length > 1)
    .map((r) => `${r.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ")} L${r[r.length - 1].x} ${base} L${r[0].x} ${base} Z`).join(" ");
  const dots = runs.filter((r) => r.length === 1).map((r) => r[0]);
  return { line, area, dots, min: Math.min(...known), max: Math.max(...known) };
}
