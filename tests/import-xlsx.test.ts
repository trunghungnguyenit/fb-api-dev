import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSheet } from "read-excel-file/node";
import writeExcelFile from "write-excel-file/node";
import { rowsFromMatrix } from "@/lib/import/columns";
import { parseScheduleInput } from "@/lib/import/time";

// Round trip with the same two libraries the browser uses: write an .xlsx, read it back, run the parser.
// This pins down how Excel DATE cells and text cells arrive, which decides whether schedule times are right.

const dir = mkdtempSync(join(tmpdir(), "import-xlsx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-10-20T02:00:00.000Z");

describe("xlsx round trip", () => {
  it("reads header, multi-line text, emoji, and a real Excel date cell as Vietnam time", async () => {
    const file = join(dir, "a.xlsx");
    await writeExcelFile([
      [{ value: "Nội dung" }, { value: "Liên kết" }, { value: "Thời gian đăng" }, { value: "Ghi chú" }],
      [{ value: "Dòng 1\nDòng 2 🚀" }, { value: "https://a.vn" },
        // An Excel date cell: 21/10/2026 08:30 wall-clock, no timezone.
        { value: new Date(Date.UTC(2026, 9, 21, 8, 30)), type: Date, format: "dd/mm/yyyy hh:mm" }, { value: "chiến dịch" }],
      [{ value: "Chỉ có nội dung" }, null, null, null]
    ]).toFile(file);

    const parsed = rowsFromMatrix(await readSheet(file));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].message).toBe("Dòng 1\nDòng 2 🚀");
    expect(parsed.rows[0].time).toBe("2026-10-21 08:30");
    expect(parsed.rows[0].note).toBe("chiến dịch");
    expect(parsed.rows[1]).toMatchObject({ line: 3, message: "Chỉ có nội dung", time: "", link: "" });

    // 08:30 on the sheet means 08:30 in Vietnam = 01:30 UTC.
    expect(parseScheduleInput(parsed.rows[0].time, NOW)).toEqual({ ok: true, iso: "2026-10-21T01:30:00.000Z" });
  });

  it("keeps a time typed as text exactly as written", async () => {
    const file = join(dir, "b.xlsx");
    await writeExcelFile([
      [{ value: "Nội dung" }, { value: "Thời gian đăng" }],
      [{ value: "Bài" }, { value: "21/10/2026 08:30" }]
    ]).toFile(file);
    const parsed = rowsFromMatrix(await readSheet(file));
    expect(parsed.ok && parsed.rows[0].time).toBe("21/10/2026 08:30");
  });
});
