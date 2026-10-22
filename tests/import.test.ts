import { describe, expect, it } from "vitest";
import { parseCsv, detectDelimiter, toCsv } from "@/lib/import/csv";
import { cellToString, normalizeHeader, rowsFromJson, rowsFromMatrix } from "@/lib/import/columns";
import { parseScheduleInput } from "@/lib/import/time";
import { duplicateKey, matchPage, summarize, validateImportRows, type PageRef, type ValidateOptions } from "@/lib/import/validate";

// 2026-10-20 09:00 in Vietnam = 02:00 UTC
const NOW = Date.parse("2026-10-20T02:00:00.000Z");

describe("parseCsv", () => {
  it("handles quotes, embedded newlines, escaped quotes and emoji", () => {
    const text = 'Nội dung,Liên kết\r\n"Dòng 1\nDòng 2 ""trích dẫn"" 🚀",https://a.vn\r\nBài hai,\r\n';
    expect(parseCsv(text)).toEqual([["Nội dung", "Liên kết"], ['Dòng 1\nDòng 2 "trích dẫn" 🚀', "https://a.vn"], ["Bài hai", ""]]);
  });

  it("strips the UTF-8 BOM Excel adds and keeps blank rows so line numbers stay right", () => {
    const rows = parseCsv("﻿A,B\n\n1,2");
    expect(rows[0][0]).toBe("A");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([""]);
  });

  it("detects the delimiter: semicolon (Vietnamese Excel), tab (pasted from Sheets), comma", () => {
    expect(detectDelimiter("Nội dung;Liên kết\na;b")).toBe(";");
    expect(detectDelimiter("Nội dung\tLiên kết\na\tb")).toBe("\t");
    expect(detectDelimiter("a,b\n1,2")).toBe(",");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
    expect(parseCsv("Nội dung;Liên kết\nA;B")).toEqual([["Nội dung", "Liên kết"], ["A", "B"]]);
  });

  it("does not drop a last row without a trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("toCsv", () => {
  it("quotes fields that need it and round-trips through parseCsv", () => {
    const rows = [["a,b", 'x"y', "line1\nline2", "plain"]];
    expect(parseCsv(toCsv(rows))).toEqual([["a,b", 'x"y', "line1\nline2", "plain"]]);
  });

  it("neutralises spreadsheet formulas in echoed data", () => {
    expect(toCsv([["=HYPERLINK(\"http://evil\")", "+1", "-2", "@x", "safe"]], { neutralizeFormulas: true })).toContain("'=HYPERLINK");
    expect(toCsv([["=1"]], { neutralizeFormulas: true })).toBe("'=1");
    expect(toCsv([["=1"]])).toBe("=1");
  });
});

describe("column mapping", () => {
  it("matches Vietnamese and English headers regardless of case and accents", () => {
    expect(normalizeHeader("Thời gian đăng")).toBe("thoigiandang");
    const r = rowsFromMatrix([["NỘI DUNG", "liên kết", "Giờ đăng", "Fanpage", "Ghi chú", "Cột lạ"], ["Xin chào", "https://a.vn", "21/10/2026 08:00", "HTStudio", "chiến dịch 1", "x"]]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toEqual([{ line: 2, message: "Xin chào", link: "https://a.vn", time: "21/10/2026 08:00", fanpage: "HTStudio", note: "chiến dịch 1", type: "", files: "" }]);
      expect(r.ignoredColumns).toEqual(["Cột lạ"]);
    }
  });

  it("requires a content column and reports an empty file", () => {
    expect(rowsFromMatrix([["Liên kết"], ["https://a.vn"]])).toEqual({ ok: false, reason: "no_message_column" });
    expect(rowsFromMatrix([["", ""], []])).toEqual({ ok: false, reason: "empty" });
  });

  it("skips blank rows but keeps the spreadsheet line number", () => {
    const r = rowsFromMatrix([["Nội dung"], ["a"], [""], ["b"]]);
    expect(r.ok && r.rows.map((x) => x.line)).toEqual([2, 4]);
  });

  it("reads Excel Date cells as wall-clock time and numbers as text", () => {
    expect(cellToString(new Date(Date.UTC(2026, 9, 21, 8, 30)))).toBe("2026-10-21 08:30");
    expect(cellToString(42)).toBe("42");
    expect(cellToString(null)).toBe("");
  });

  it("accepts JSON arrays and {posts: []} with loose keys", () => {
    const a = rowsFromJson([{ message: "A", time: "2026-10-21 08:00", page: "HTStudio" }, { content: "B" }]);
    expect(a.ok && a.rows.map((r) => [r.line, r.message, r.fanpage])).toEqual([[1, "A", "HTStudio"], [2, "B", ""]]);
    expect(rowsFromJson({ posts: [{ "Nội dung": "C" }] }).ok).toBe(true);
    expect(rowsFromJson({ nope: 1 })).toEqual({ ok: false, reason: "empty" });
    expect(rowsFromJson([{ foo: "x" }])).toEqual({ ok: false, reason: "no_message_column" });
  });
});

describe("parseScheduleInput (Vietnam time, GMT+7)", () => {
  it("reads Vietnamese day-first and ISO-like formats as GMT+7", () => {
    for (const text of ["21/10/2026 08:00", "21-10-2026 08:00", "21.10.2026 8:00", "21/10/2026 08h00", "2026-10-21 08:00", "2026-10-21T08:00"]) {
      expect(parseScheduleInput(text, NOW), text).toEqual({ ok: true, iso: "2026-10-21T01:00:00.000Z" });
    }
  });

  it("keeps an explicit timezone as given", () => {
    expect(parseScheduleInput("2026-10-21T08:00:00Z", NOW)).toEqual({ ok: true, iso: "2026-10-21T08:00:00.000Z" });
    expect(parseScheduleInput("2026-10-21T08:00:00+07:00", NOW)).toEqual({ ok: true, iso: "2026-10-21T01:00:00.000Z" });
  });

  it("reads an Excel serial number", () => {
    // 46316.5 = 2026-10-21 12:00 (wall clock) -> 05:00 UTC
    expect(parseScheduleInput("46316.5", NOW)).toEqual({ ok: true, iso: "2026-10-21T05:00:00.000Z" });
  });

  it("rejects impossible, past, date-only and far-future values with a reason", () => {
    expect(parseScheduleInput("31/02/2026 08:00", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(parseScheduleInput("21/10/2026 25:00", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(parseScheduleInput("hôm nay", NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(parseScheduleInput("21/10/2026", NOW)).toEqual({ ok: false, reason: "no_time" });
    expect(parseScheduleInput("19/10/2026 08:00", NOW)).toEqual({ ok: false, reason: "past" });
    expect(parseScheduleInput("21/10/2031 08:00", NOW)).toEqual({ ok: false, reason: "too_far" });
  });

  it("tolerates a few seconds in the past (clock skew) but not minutes", () => {
    expect(parseScheduleInput("20/10/2026 09:00", NOW).ok).toBe(true);
    expect(parseScheduleInput("20/10/2026 08:58", NOW)).toEqual({ ok: false, reason: "past" });
  });
});

const pages: PageRef[] = [
  { id: "p1", page_name: "HTStudio", page_id: "1001" },
  { id: "p2", page_name: "HTStudio Test", page_id: "1002" },
  { id: "p3", page_name: "Cửa Hàng", page_id: "1003" },
  { id: "p4", page_name: "cua hang", page_id: "1004" }
];
const opts = (over: Partial<ValidateOptions> = {}): ValidateOptions => ({
  pages, defaultPageId: "p1", nowMs: NOW, existing: new Set(), spread: null, includeDuplicates: false, ...over
});
const row = (line: number, over: Partial<{ message: string; link: string; time: string; fanpage: string; note: string; type: string; files: string }> = {}) =>
  ({ line, message: "Bài", link: "", time: "", fanpage: "", note: "", type: "", files: "", ...over });

describe("matchPage", () => {
  it("falls back to the default page, then matches by name (no accents/case) or Facebook id", () => {
    expect(matchPage("", pages, "p1")).toMatchObject({ ok: true, page: { id: "p1" } });
    expect(matchPage("htstudio TEST", pages, "p1")).toMatchObject({ ok: true, page: { id: "p2" } });
    expect(matchPage("1002", pages, "p1")).toMatchObject({ ok: true, page: { id: "p2" } });
  });

  it("refuses an unknown or ambiguous name instead of guessing", () => {
    expect(matchPage("Không có", pages, "p1")).toEqual({ ok: false, reason: "not_found" });
    expect(matchPage("Cửa hàng", pages, "p1")).toEqual({ ok: false, reason: "ambiguous" }); // "Cửa Hàng" vs "cua hang"
    expect(matchPage("1003", pages, "p1")).toMatchObject({ ok: true, page: { id: "p3" } }); // the id disambiguates
  });
});

describe("validateImportRows", () => {
  it("accepts a draft (no time) and a scheduled post, and uses the default Fanpage", () => {
    const [a, b] = validateImportRows([row(2), row(3, { message: "Khác", time: "21/10/2026 08:00" })], opts());
    expect(a).toMatchObject({ willImport: true, scheduledAt: null, pageId: "p1" });
    expect(b).toMatchObject({ willImport: true, scheduledAt: "2026-10-21T01:00:00.000Z" });
  });

  it("reports each problem on its own row and keeps the other rows importable", () => {
    const r = validateImportRows([
      row(2, { message: "" }),
      row(3, { link: "ftp://x" }),
      row(4, { fanpage: "Không có" }),
      row(5, { time: "19/10/2026 08:00" }),
      row(6, { message: "x".repeat(63207) }),
      row(7, { message: "ok", time: "21/10/2026 08:00" })
    ], opts());
    expect(r.map((x) => x.errors[0]?.code)).toEqual(["MESSAGE_EMPTY", "LINK_INVALID", "PAGE_NOT_FOUND", "TIME_PAST", "MESSAGE_TOO_LONG", undefined]);
    expect(r.filter((x) => x.willImport).map((x) => x.line)).toEqual([7]);
  });

  it("flags duplicates inside the file (later rows) and against existing posts, and skips them by default", () => {
    const existing = new Set([duplicateKey("p1", "Đã có")]);
    const r = validateImportRows([row(2, { message: "Mới" }), row(3, { message: "Mới" }), row(4, { message: "Đã có" }), row(5, { message: "Mới", fanpage: "HTStudio Test" })], opts({ existing }));
    expect(r.map((x) => x.duplicate)).toEqual([null, { kind: "file", line: 2 }, { kind: "existing" }, null]);
    expect(r.map((x) => x.willImport)).toEqual([true, false, false, true]);
    const all = validateImportRows([row(2), row(3)], opts({ includeDuplicates: true }));
    expect(all.every((x) => x.willImport)).toBe(true);
  });

  it("spreads rows without a time over the schedule, skipping rows that have a time or will not import", () => {
    const start = Date.parse("2026-10-21T01:00:00.000Z");
    const r = validateImportRows([
      row(2, { message: "A" }), row(3, { message: "B", time: "22/10/2026 08:00" }),
      row(4, { message: "" }), row(5, { message: "C" }), row(6, { message: "A" })
    ], opts({ spread: { startMs: start, intervalMinutes: 360 } }));
    expect(r.map((x) => x.scheduledAt)).toEqual(["2026-10-21T01:00:00.000Z", "2026-10-22T01:00:00.000Z", null, "2026-10-21T07:00:00.000Z", null]);
    expect(r.map((x) => x.autoScheduled)).toEqual([true, false, false, true, false]);
  });

  it("normalises CRLF in messages and summarises the batch", () => {
    const r = validateImportRows([row(2, { message: "a\r\nb" }), row(3, { message: "" }), row(4, { message: "c", time: "21/10/2026 08:00" })], opts());
    expect(r[0].message).toBe("a\nb");
    expect(summarize(r)).toEqual({ total: 3, willImport: 2, errors: 1, duplicates: 0, scheduled: 1, drafts: 1, withMedia: 0 });
  });
});
