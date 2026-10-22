// Meta tells us how close we are to its rate limits in response headers (X-App-Usage, X-Page-Usage,
// X-Business-Use-Case-Usage: percentages of the allowance) and with error codes. This module turns both into
// "slow down" / "stop until T" decisions per bucket, so we back off BEFORE Meta starts rejecting calls.
//
// Buckets: "app" (the whole app; X-App-Usage and error 4) and one per access token (a Page token means one
// Page; X-Page-Usage and the business-use-case header belong to it). State lives in this process only, which is
// right for a single long-running server; with several processes each learns from its own responses.

/** Codes that mean "too many calls". 4 is app-level; the others are user/Page/business-use-case level. */
const RATE_LIMIT_CODES = new Set(["4", "17", "32", "613", "80001", "80006"]);
export const isRateLimitCode = (code: string) => RATE_LIMIT_CODES.has(code);
/** Raised locally (no request sent) while a bucket is blocked. Not a Meta code. */
export const LOCAL_RATE_LIMIT_CODE = "LOCAL_RATE_LIMIT";

export const USAGE_POLICY = {
  /** From this usage on, calls are spaced out. */
  slowPct: 80,
  slowerPct: 90,
  slowDelayMs: 1_000,
  slowerDelayMs: 3_000,
  /** From this usage on, calls stop until the allowance has had time to recover. */
  blockPct: 95,
  /** Pause when Meta did not say how long (usage windows are rolling, so a short pause helps). */
  defaultBlockMs: 60_000,
  /** Repeated rejections without a hint back off 60s, 120s, 240s ... up to this. */
  maxBackoffMs: 15 * 60_000,
  /** A reading older than this no longer says anything about the present. */
  staleAfterMs: 10 * 60_000
} as const;

export type UsageFigures = { callCount: number; totalCpu: number; totalTime: number };
export type ParsedUsage = { app?: UsageFigures; page?: UsageFigures; business?: { pct: number; regainMs: number } };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function figures(value: unknown): UsageFigures | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  return { callCount: num(o.call_count), totalCpu: num(o.total_cputime), totalTime: num(o.total_time) };
}

export const usagePct = (f: UsageFigures) => Math.max(f.callCount, f.totalCpu, f.totalTime);

function jsonHeader(headers: Headers, name: string): unknown {
  const raw = headers.get(name);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Reads the usage headers of one response. Missing or malformed headers simply yield nothing. */
export function parseUsageHeaders(headers: Headers): ParsedUsage {
  const parsed: ParsedUsage = { app: figures(jsonHeader(headers, "x-app-usage")), page: figures(jsonHeader(headers, "x-page-usage")) };
  // { "<business id>": [ { type, call_count, total_cputime, total_time, estimated_time_to_regain_access (minutes) } ] }
  const business = jsonHeader(headers, "x-business-use-case-usage");
  if (business && typeof business === "object") {
    let pct = 0;
    let regainMs = 0;
    for (const entries of Object.values(business as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const f = figures(entry);
        if (f) pct = Math.max(pct, usagePct(f));
        regainMs = Math.max(regainMs, num((entry as Record<string, unknown>)?.estimated_time_to_regain_access) * 60_000);
      }
    }
    if (pct || regainMs) parsed.business = { pct, regainMs };
  }
  return parsed;
}

type Entry = { pct: number; readAt: number; blockedUntil: number; strikes: number };
export type Gate = { blockedUntil?: number; delayMs: number };

export const APP_BUCKET = "app";

export class UsageTracker {
  private entries = new Map<string, Entry>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private entry(bucket: string) {
    let e = this.entries.get(bucket);
    if (!e) { e = { pct: 0, readAt: 0, blockedUntil: 0, strikes: 0 }; this.entries.set(bucket, e); }
    return e;
  }

  private observe(bucket: string, pct: number, regainMs: number) {
    const e = this.entry(bucket);
    e.pct = pct;
    e.readAt = this.now();
    if (pct >= USAGE_POLICY.blockPct) e.blockedUntil = Math.max(e.blockedUntil, this.now() + (regainMs || USAGE_POLICY.defaultBlockMs));
  }

  /** Records the usage headers of a response (also of failed ones: that is when they matter most). */
  record(bucket: string, usage: ParsedUsage) {
    if (usage.app) this.observe(APP_BUCKET, usagePct(usage.app), 0);
    const pagePct = Math.max(usage.page ? usagePct(usage.page) : 0, usage.business?.pct ?? 0);
    if (usage.page || usage.business) this.observe(bucket, pagePct, usage.business?.regainMs ?? 0);
  }

  /**
   * Meta rejected a call for rate limiting. Error 4 is app-wide, the other codes belong to this token's bucket.
   * `regainMs` is Meta's own estimate when it gave one. Returns when calls may resume.
   */
  noteRateLimited(bucket: string, code: string, regainMs = 0) {
    const e = this.entry(code === "4" ? APP_BUCKET : bucket);
    e.strikes++;
    const backoff = Math.min(USAGE_POLICY.defaultBlockMs * 2 ** (e.strikes - 1), USAGE_POLICY.maxBackoffMs);
    e.blockedUntil = Math.max(e.blockedUntil, this.now() + (regainMs || backoff));
    return e.blockedUntil;
  }

  /** A call went through: a streak of rejections is over. */
  noteSuccess(bucket: string) {
    for (const key of [bucket, APP_BUCKET]) {
      const e = this.entries.get(key);
      if (e) e.strikes = 0;
    }
  }

  /** What to do before sending a call with this bucket's token: stop (until when) or wait a little. */
  gate(bucket: string): Gate {
    const now = this.now();
    let blockedUntil = 0;
    let delayMs = 0;
    for (const key of [bucket, APP_BUCKET]) {
      const e = this.entries.get(key);
      if (!e) continue;
      if (e.blockedUntil > now) blockedUntil = Math.max(blockedUntil, e.blockedUntil);
      if (now - e.readAt <= USAGE_POLICY.staleAfterMs) {
        if (e.pct >= USAGE_POLICY.slowerPct) delayMs = Math.max(delayMs, USAGE_POLICY.slowerDelayMs);
        else if (e.pct >= USAGE_POLICY.slowPct) delayMs = Math.max(delayMs, USAGE_POLICY.slowDelayMs);
      }
    }
    return blockedUntil ? { blockedUntil, delayMs } : { delayMs };
  }

  /** For logs and diagnostics: current figures per bucket (bucket ids are token fingerprints, never tokens). */
  snapshot() {
    const now = this.now();
    return [...this.entries].map(([bucket, e]) => ({
      bucket, pct: e.pct, readAgoMs: e.readAt ? now - e.readAt : null, blockedForMs: Math.max(0, e.blockedUntil - now), strikes: e.strikes
    }));
  }
}

// One tracker per process, surviving dev hot reloads.
const g = globalThis as { __metaUsageTracker?: UsageTracker };
export const usageTracker = (g.__metaUsageTracker ??= new UsageTracker());
