import { describe, expect, it } from "vitest";
import {
  addDays, changePercent, changeTone, chartGeometry, dayOfEndTime, daysInclusive, fillDays, formatYmd, graphWindow, INSIGHT_METRICS,
  compareDays, diffTone, isYmd, mainValue, MAX_RANGE_DAYS, metricErrorKind, parseInsights, previousRange, resolveRange, todayVN
} from "@/lib/meta/insights";

// 12:00 on 25 Oct 2026 in Vietnam.
const NOW = new Date("2026-10-25T05:00:00Z");

describe("dates", () => {
  it("works in whole days", () => {
    expect(isYmd("2026-10-25")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("25/10/2026")).toBe(false);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysInclusive("2026-10-01", "2026-10-07")).toBe(7);
    expect(formatYmd("2026-10-05")).toBe("05/10/2026");
  });

  it("takes today from Vietnam's clock, not the server's", () => {
    expect(todayVN(new Date("2026-10-24T20:30:00Z"))).toBe("2026-10-25"); // already tomorrow in Vietnam
  });
});

describe("resolveRange", () => {
  it("defaults to 28 days and ends yesterday (today's numbers are not in yet)", () => {
    const r = resolveRange({}, NOW);
    expect(r).toEqual({ ok: true, range: { preset: "28d", start: "2026-09-27", end: "2026-10-24", days: 28 } });
    for (const [range, days] of [["7d", 7], ["90d", 90]] as const) {
      const got = resolveRange({ range }, NOW);
      expect(got.ok && got.range.days).toBe(days);
      expect(got.ok && daysInclusive(got.range.start, got.range.end)).toBe(days);
    }
  });

  it("names a wrong preset", () => {
    const r = resolveRange({ range: "1y" }, NOW);
    expect(r.ok === false && r.errors.range).toMatch(/Khoảng ngày không hợp lệ/);
  });

  it("a custom range needs both days, each a real date", () => {
    expect(resolveRange({ range: "custom" }, NOW)).toMatchObject({ ok: false, errors: { since: "Chọn ngày bắt đầu.", until: "Chọn ngày kết thúc." } });
    expect(resolveRange({ range: "custom", since: "2026-13-01", until: "2026-10-01" }, NOW)).toMatchObject({ ok: false, errors: { since: expect.stringMatching(/chưa đúng/) } });
  });

  it("refuses an end before the start, a future end, more than 93 days, and anything older than 2 years", () => {
    const err = (since: string, until: string) => { const r = resolveRange({ range: "custom", since, until }, NOW); return r.ok ? null : r.errors; };
    expect(err("2026-10-10", "2026-10-01")?.until).toMatch(/cùng ngày hoặc sau ngày bắt đầu/);
    expect(err("2026-10-20", "2026-10-26")?.until).toBe("Không chọn được ngày trong tương lai.");
    expect(err("2026-06-01", "2026-10-01")?.until).toMatch(/tối đa 93 ngày \(bạn đang chọn 123 ngày\)/);
    expect(err("2024-01-01", "2024-01-10")?.since).toMatch(/2 năm gần nhất.*từ \d\d\/\d\d\/\d{4}/);
  });

  it("accepts exactly 93 days, and a range that ends today", () => {
    expect(resolveRange({ range: "custom", since: addDays("2026-10-25", -(MAX_RANGE_DAYS - 1)), until: "2026-10-25" }, NOW).ok).toBe(true);
    expect(resolveRange({ range: "custom", since: addDays("2026-10-25", -MAX_RANGE_DAYS), until: "2026-10-25" }, NOW).ok).toBe(false);
  });
});

describe("previous range and the Graph window", () => {
  it("is the same number of days right before the range", () => {
    const range = { preset: "custom" as const, start: "2026-10-01", end: "2026-10-10", days: 10 };
    expect(previousRange(range, NOW)).toMatchObject({ start: "2026-09-21", end: "2026-09-30", days: 10 });
  });

  it("is null when it would reach past what Facebook keeps", () => {
    const old = { preset: "custom" as const, start: "2024-11-01", end: "2024-11-10", days: 10 };
    expect(previousRange(old, NOW)).toBeNull();
  });

  it("asks Graph until the day AFTER the last day wanted", () => {
    expect(graphWindow({ preset: "7d", start: "2026-10-18", end: "2026-10-24", days: 7 })).toEqual({ since: "2026-10-18", until: "2026-10-25" });
  });
});

describe("reading Facebook's answer", () => {
  it("dates a value by the day BEFORE its end_time, whatever the offset format", () => {
    expect(dayOfEndTime("2026-10-20T07:00:00+0000")).toBe("2026-10-19");
    expect(dayOfEndTime("2026-10-20T00:00:00+0000")).toBe("2026-10-19");
    expect(dayOfEndTime("nonsense")).toBeNull();
    expect(dayOfEndTime(5)).toBeNull();
  });

  it("parses numbers, sums breakdown objects, keeps nulls, and skips what it cannot use", () => {
    const parsed = parseInsights({
      data: [
        { name: "page_media_view", period: "day", values: [
          { value: 10, end_time: "2026-10-02T07:00:00+0000" }, { value: { a: 3, b: 4 }, end_time: "2026-10-03T07:00:00+0000" },
          { value: "x", end_time: "2026-10-04T07:00:00+0000" }, { value: 1 }
        ] },
        { name: 5, values: [] }, { name: "no_values" }, null
      ]
    });
    expect([...parsed.keys()]).toEqual(["page_media_view"]);
    expect(parsed.get("page_media_view")).toEqual([
      { date: "2026-10-01", value: 10 }, { date: "2026-10-02", value: 7 }, { date: "2026-10-03", value: null }
    ]);
    expect(parseInsights(null).size).toBe(0);
    expect(parseInsights({ data: "x" }).size).toBe(0);
  });

  it("gives one entry per day of the range, with null for days Facebook said nothing about", () => {
    const filled = fillDays([{ date: "2026-10-02", value: 5 }, { date: "2026-09-01", value: 9 }], { start: "2026-10-01", end: "2026-10-03" });
    expect(filled).toEqual([{ date: "2026-10-01", value: null }, { date: "2026-10-02", value: 5 }, { date: "2026-10-03", value: null }]);
  });
});

describe("the number on a card", () => {
  const series = [{ date: "a", value: 10 }, { date: "b", value: null }, { date: "c", value: 20 }];
  it("totals, averages the days that have a value, or takes the last one", () => {
    expect(mainValue("sum", series)).toBe(30);
    expect(mainValue("average", series)).toBe(15);
    expect(mainValue("last", series)).toBe(20);
    expect(mainValue("sum", [{ date: "a", value: null }])).toBeNull();
    expect(mainValue("sum", [])).toBeNull();
  });

  it("compares with the previous period, and says nothing when there is nothing to compare", () => {
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(50, 100)).toBe(-50);
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(5, null)).toBeNull();
    expect(changePercent(null, 5)).toBeNull();
  });

  it("colours a rise as good or bad depending on the metric", () => {
    expect(changeTone(20, "up")).toBe("good");
    expect(changeTone(20, "down")).toBe("bad"); // more people leaving
    expect(changeTone(-20, "down")).toBe("good");
    expect(changeTone(0, "up")).toBe("flat");
    expect(changeTone(null, "up")).toBe("flat");
  });

  it("covers six metrics, each with its own Graph name", () => {
    expect(INSIGHT_METRICS.map((m) => m.graph)).toEqual([
      "page_media_view", "page_total_media_view_unique", "page_follows", "page_daily_follows", "page_daily_unfollows_unique", "page_post_engagements"
    ]);
    // The "impressions" and "fans" families are retired: never asked for.
    for (const m of INSIGHT_METRICS) expect(m.graph).not.toMatch(/impressions|fans/);
  });
});

describe("telling Facebook's refusals apart", () => {
  it("a code 100 that names the metric = Facebook no longer knows it", () => {
    expect(metricErrorKind({ code: "100", message: "(#100) The value must be a valid insights metric" })).toBe("unsupported");
    expect(metricErrorKind({ code: "100", message: "Invalid metric: page_fans" })).toBe("unsupported");
  });
  it("permission codes mean the Page is off limits", () => {
    for (const code of ["10", "200", "283", "459"]) expect(metricErrorKind({ code, message: "x" })).toBe("permission");
    expect(metricErrorKind({ code: "100", subcode: "33", message: "Unsupported get request" })).toBe("permission");
  });
  it("anything else is a failure of that metric only", () => {
    expect(metricErrorKind({ code: "100", message: "Something else" })).toBe("failed");
    expect(metricErrorKind({ code: "2", message: "x" })).toBe("failed");
  });
});

describe("chartGeometry", () => {
  const box = { width: 100, height: 50, padX: 0, padTop: 0, padBottom: 0 };
  it("draws a line and an area for a run of days, from a zero baseline", () => {
    const g = chartGeometry([0, 10], box);
    expect(g.line).toBe("M0 50 L100 0");
    expect(g.area).toBe("M0 50 L100 0 L100 50 L0 50 Z");
    expect(g.min).toBe(0);
    expect(g.max).toBe(10);
  });
  it("breaks the line at a gap instead of drawing it as zero, and dots a day on its own", () => {
    const g = chartGeometry([5, null, 5, 5], box);
    expect(g.dots).toHaveLength(1);
    expect(g.line.match(/M/g)).toHaveLength(1);
    expect(chartGeometry([null, null], box)).toEqual({ line: "", area: "", dots: [], min: 0, max: 0 });
  });
  it("reports the real lowest and highest value even when the scale is widened for a flat line", () => {
    // Seen on a real Page: 9 followers every day was labelled "highest: 10", and 0 new follows "highest: 1".
    const followers = chartGeometry([9, 9, 9], { ...box, zeroBased: false });
    expect([followers.min, followers.max]).toEqual([9, 9]);
    const none = chartGeometry([0, 0, 0], box);
    expect([none.min, none.max]).toEqual([0, 0]);
    expect(none.line).not.toContain("NaN");
  });
  it("copes with a flat series and with a scale that does not start at zero", () => {
    expect(chartGeometry([7, 7, 7], box).line).not.toContain("NaN");
    const levels = chartGeometry([1000, 1010], { ...box, zeroBased: false });
    expect(levels.min).toBe(1000);
    expect(levels.max).toBe(1010);
  });
});

describe("compareDays", () => {
  const day = (date: string, value: number | null) => ({ date, value });
  const now = [day("2026-10-01", 10), day("2026-10-02", 0), day("2026-10-03", null), day("2026-10-04", 7)];
  const before = [day("2026-09-27", 5), day("2026-09-28", 0), day("2026-09-29", 4), day("2026-09-30", null)];

  it("puts each day next to the day in the same place of the previous period, with the difference and the change in percent", () => {
    const rows = compareDays(now, before);
    expect(rows[0]).toEqual({ date: "2026-10-01", value: 10, previousDate: "2026-09-27", previousValue: 5, diff: 5, percent: 100 });
    // 0 against 0: no change, and no percent of nothing
    expect(rows[1]).toMatchObject({ value: 0, previousValue: 0, diff: 0, percent: null });
  });

  it("compares only what both periods know, and never turns a missing number into zero", () => {
    const rows = compareDays(now, before);
    expect(rows[2]).toMatchObject({ value: null, previousValue: 4, diff: null, percent: null });
    expect(rows[3]).toMatchObject({ value: 7, previousValue: null, diff: null, percent: null });
  });

  it("gives a difference but no percent for a day whose previous day was zero", () => {
    expect(compareDays([day("2026-10-01", 3)], [day("2026-09-30", 0)])[0]).toMatchObject({ diff: 3, percent: null });
  });

  it("carries no comparison when there is no previous period, or when it is shorter", () => {
    expect(compareDays(now, null).every((r) => r.previousDate === null && r.previousValue === null && r.diff === null && r.percent === null)).toBe(true);
    expect(compareDays(now, before.slice(0, 1))[1]).toMatchObject({ previousDate: null, diff: null });
    expect(compareDays([], before)).toEqual([]);
  });

  it("is a decrease against the previous day when the value fell, in percent as well", () => {
    expect(compareDays([day("2026-10-01", 3)], [day("2026-09-30", 4)])[0]).toMatchObject({ diff: -1, percent: -25 });
  });
});

describe("diffTone", () => {
  it("is good when the number moved the way the metric wants, bad when it moved the other way, and flat when it did not move or is unknown", () => {
    expect(diffTone(5, "up")).toBe("good");
    expect(diffTone(-5, "up")).toBe("bad");
    expect(diffTone(5, "down")).toBe("bad");
    expect(diffTone(-5, "down")).toBe("good");
    expect(diffTone(0, "up")).toBe("flat");
    expect(diffTone(null, "down")).toBe("flat");
  });
});
