// Reads the "Thời gian đăng" cell. Spreadsheet times carry no timezone, so they are interpreted as Vietnam
// time (GMT+7), the same zone the app displays. Pure, so the browser, API and tests share one rule.

export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const PAST_TOLERANCE_MS = 60_000;
const MAX_AHEAD_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // Excel serial day 0 (accounts for the 1900 leap-year bug)

export type TimeResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "invalid" | "no_time" | "past" | "too_far" };

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** Builds epoch ms from wall-clock parts in GMT+7, rejecting impossible dates (31/02, 25:00...). */
function fromVietnamParts(p: Parts): number | null {
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.d > 31 || p.h > 23 || p.mi > 59 || p.s > 59) return null;
  const utc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== p.y || check.getUTCMonth() !== p.mo - 1 || check.getUTCDate() !== p.d) return null;
  return utc - VN_OFFSET_MS;
}

const num = (s: string | undefined) => (s === undefined ? 0 : Number(s));

export function parseScheduleInput(raw: string, nowMs: number): TimeResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "invalid" };

  let ms: number | null = null;

  // 1) ISO with an explicit zone (2026-10-21T08:00:00+07:00 / ...Z): unambiguous.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const t = Date.parse(text.replace(" ", "T").replace(/\s+/g, ""));
    ms = Number.isNaN(t) ? null : t;
  }
  // 2) Naive year-first: 2026-10-21 08:00[:ss] (what an Excel date cell becomes).
  else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
    const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/)!;
    ms = fromVietnamParts({ y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: num(m[6]) });
  }
  // 3) Day-first (Vietnamese): 21/10/2026 08:00[:ss], also with - or .
  else if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}[T ,]+\d{1,2}[:hH]\d{2}(:\d{2})?$/.test(text)) {
    const m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[T ,]+(\d{1,2})[:hH](\d{2})(?::(\d{2}))?$/)!;
    ms = fromVietnamParts({ y: +m[3], mo: +m[2], d: +m[1], h: +m[4], mi: +m[5], s: num(m[6]) });
  }
  // 4) A date with no time of day: we refuse to guess an hour.
  else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(text)) {
    return { ok: false, reason: "no_time" };
  }
  // 5) Excel serial number (46316.5 = a day plus a fraction of a day), if a cell was not exported as a date.
  else if (/^\d{5}(\.\d+)?$/.test(text) && Number(text) > 25569 && Number(text) < 80000) {
    const naive = EXCEL_EPOCH_UTC + Math.round(Number(text) * 86_400_000);
    ms = naive - VN_OFFSET_MS;
  }

  if (ms === null) return { ok: false, reason: "invalid" };
  if (ms < nowMs - PAST_TOLERANCE_MS) return { ok: false, reason: "past" };
  if (ms > nowMs + MAX_AHEAD_MS) return { ok: false, reason: "too_far" };
  return { ok: true, iso: new Date(ms).toISOString() };
}

/** "dd/mm/yyyy hh:mm" in Vietnam time, for previews and reports. */
export function formatVietnamTime(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
