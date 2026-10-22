import { describe, expect, it } from "vitest";
import { MetaApiError, MetaRateLimitedError } from "@/lib/meta/client";
import { describeMetaError } from "@/lib/meta/pages";
import { APP_BUCKET, isRateLimitCode, parseUsageHeaders, UsageTracker, USAGE_POLICY } from "@/lib/meta/usage";

const headers = (h: Record<string, unknown>) =>
  new Headers(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));

describe("parseUsageHeaders", () => {
  it("reads app and page usage", () => {
    const u = parseUsageHeaders(headers({
      "x-app-usage": { call_count: 28, total_cputime: 25, total_time: 31 },
      "x-page-usage": { call_count: 90, total_cputime: 12, total_time: 5 }
    }));
    expect(u.app).toEqual({ callCount: 28, totalCpu: 25, totalTime: 31 });
    expect(u.page).toEqual({ callCount: 90, totalCpu: 12, totalTime: 5 });
    expect(u.business).toBeUndefined();
  });

  it("takes the worst entry of the business-use-case header and converts minutes to ms", () => {
    const u = parseUsageHeaders(headers({
      "x-business-use-case-usage": {
        "123": [
          { type: "pages", call_count: 40, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 },
          { type: "pages", call_count: 100, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 7 }
        ],
        "456": [{ type: "pages", call_count: 5, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 2 }]
      }
    }));
    expect(u.business).toEqual({ pct: 100, regainMs: 7 * 60_000 });
  });

  it("ignores missing and malformed headers", () => {
    expect(parseUsageHeaders(new Headers())).toEqual({ app: undefined, page: undefined });
    const u = parseUsageHeaders(headers({ "x-app-usage": "{not json", "x-page-usage": "[]", "x-business-use-case-usage": "7" }));
    expect(u.app).toBeUndefined();
    expect(u.business).toBeUndefined();
  });
});

describe("UsageTracker", () => {
  const make = () => {
    let t = 1_000_000;
    const tracker = new UsageTracker(() => t);
    return { tracker, now: () => t, advance: (ms: number) => { t += ms; } };
  };
  const page = (pct: number) => ({ page: { callCount: pct, totalCpu: 0, totalTime: 0 } });

  it("lets calls through while usage is low", () => {
    const { tracker } = make();
    tracker.record("tok", { ...page(10), app: { callCount: 5, totalCpu: 5, totalTime: 5 } });
    expect(tracker.gate("tok")).toEqual({ delayMs: 0 });
    expect(tracker.gate("unknown")).toEqual({ delayMs: 0 });
  });

  it("slows calls from 80% and more from 90%", () => {
    const { tracker } = make();
    tracker.record("tok", page(80));
    expect(tracker.gate("tok").delayMs).toBe(USAGE_POLICY.slowDelayMs);
    tracker.record("tok", page(92));
    expect(tracker.gate("tok").delayMs).toBe(USAGE_POLICY.slowerDelayMs);
    expect(tracker.gate("tok").blockedUntil).toBeUndefined();
  });

  it("blocks from 95% for Meta's own estimate, else for the default pause", () => {
    const a = make();
    a.tracker.record("tok", { business: { pct: 97, regainMs: 4 * 60_000 } });
    expect(a.tracker.gate("tok").blockedUntil).toBe(1_000_000 + 4 * 60_000);
    a.advance(4 * 60_000 + 1);
    expect(a.tracker.gate("tok").blockedUntil).toBeUndefined();

    const b = make();
    b.tracker.record("tok", page(96));
    expect(b.tracker.gate("tok").blockedUntil).toBe(1_000_000 + USAGE_POLICY.defaultBlockMs);
  });

  it("an old reading no longer slows calls", () => {
    const { tracker, advance } = make();
    tracker.record("tok", page(85));
    advance(USAGE_POLICY.staleAfterMs + 1);
    expect(tracker.gate("tok").delayMs).toBe(0);
  });

  it("keeps Pages apart, but app-wide usage affects everyone", () => {
    const { tracker } = make();
    tracker.record("page-a", page(99));
    expect(tracker.gate("page-a").blockedUntil).toBeDefined();
    expect(tracker.gate("page-b").blockedUntil).toBeUndefined();

    tracker.record("page-b", { app: { callCount: 96, totalCpu: 0, totalTime: 0 } });
    expect(tracker.gate("page-b").blockedUntil).toBeDefined();
    expect(tracker.gate("page-c").blockedUntil).toBeDefined();
  });

  it("blocks the whole app on error 4 and only the token on the other rate-limit codes", () => {
    const { tracker } = make();
    tracker.noteRateLimited("page-a", "32");
    expect(tracker.gate("page-a").blockedUntil).toBeDefined();
    expect(tracker.gate("page-b").blockedUntil).toBeUndefined();
    tracker.noteRateLimited("page-a", "4");
    expect(tracker.gate("page-b").blockedUntil).toBeDefined();
  });

  it("backs off 60s, 120s, 240s ... up to the cap, and starts over after a success", () => {
    const ctx = make();
    const rejectAndWait = () => {
      const wait = ctx.tracker.noteRateLimited("t", "32") - ctx.now();
      ctx.advance(wait + 1);
      return wait;
    };
    expect(Array.from({ length: 7 }, rejectAndWait)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);

    ctx.tracker.noteSuccess("t");
    expect(rejectAndWait()).toBe(60_000);
  });

  it("uses Meta's estimate instead of the back-off when it gave one", () => {
    const { tracker } = make();
    expect(tracker.noteRateLimited("t", "80001", 5 * 60_000)).toBe(1_000_000 + 5 * 60_000);
  });

  it("reports per-bucket figures without any token", () => {
    const { tracker } = make();
    tracker.record("abc123", { ...page(50), app: { callCount: 10, totalCpu: 0, totalTime: 0 } });
    expect(tracker.snapshot().map((s) => s.bucket).sort()).toEqual([APP_BUCKET, "abc123"].sort());
  });
});

describe("rate limit error mapping", () => {
  it("knows Meta's rate-limit codes", () => {
    for (const code of ["4", "17", "32", "613", "80001", "80006"]) expect(isRateLimitCode(code)).toBe(true);
    for (const code of ["1", "100", "190", "200", "368"]) expect(isRateLimitCode(code)).toBe(false);
  });

  it("shows our own back-off to the user as a rate limit", () => {
    const local = new MetaRateLimitedError(Date.now() + 1000);
    expect(local).toBeInstanceOf(MetaApiError);
    expect(describeMetaError(local)).toBe("FB_RATE_LIMITED");
    expect(local.retryAt).toBeGreaterThan(Date.now());
  });
});
