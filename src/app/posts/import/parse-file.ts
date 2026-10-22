import { rowsFromJson, rowsFromMatrix, type ParsedRows, type RawRow } from "@/lib/import/columns";
import { parseCsv } from "@/lib/import/csv";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "@/lib/import/validate";
import type { ErrorCode } from "@/lib/errors";

// Runs in the browser: the server never parses an uploaded file, it only receives the extracted rows as JSON
// and re-validates every one of them.

export type ImportFormat = "csv" | "xlsx" | "json" | "paste";
export type ParseOutcome =
  | { ok: true; rows: RawRow[]; ignoredColumns: string[]; format: ImportFormat; sourceName: string }
  | { ok: false; code: ErrorCode; detail?: string };

function finish(parsed: ParsedRows, format: ImportFormat, sourceName: string): ParseOutcome {
  if (!parsed.ok) return { ok: false, code: parsed.reason === "empty" ? "IMPORT_PARSE_EMPTY" : "IMPORT_PARSE_NO_COLUMN" };
  if (parsed.rows.length === 0) return { ok: false, code: "IMPORT_PARSE_EMPTY" };
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return { ok: false, code: "IMPORT_TOO_MANY_ROWS", detail: `Tệp có ${parsed.rows.length} dòng; mỗi lần nhập tối đa ${MAX_IMPORT_ROWS} dòng.` };
  }
  return { ok: true, rows: parsed.rows, ignoredColumns: parsed.ignoredColumns, format, sourceName };
}

/** Text from a CSV/TSV file. Excel's plain "CSV" on Vietnamese Windows is often Windows-1258, not UTF-8. */
async function readText(file: File) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("windows-1258").decode(buffer); } catch { return utf8; }
}

export async function parseImportFile(file: File): Promise<ParseOutcome> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, code: "IMPORT_FILE_TOO_BIG" };
  const name = file.name;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  try {
    if (ext === "xlsx") {
      // Loaded on demand: only the import page pays for the Excel reader.
      const { readSheet } = await import("read-excel-file/browser");
      return finish(rowsFromMatrix(await readSheet(file)), "xlsx", name);
    }
    if (ext === "json") {
      return finish(rowsFromJson(JSON.parse(await file.text())), "json", name);
    }
    if (ext === "csv" || ext === "tsv" || ext === "txt") {
      return finish(rowsFromMatrix(parseCsv(await readText(file))), "csv", name);
    }
    return { ok: false, code: "IMPORT_FILE_UNREADABLE", detail: ext === "xls" ? "Định dạng Excel cũ (.xls) chưa được hỗ trợ. Hãy lưu lại thành .xlsx hoặc CSV." : undefined };
  } catch {
    return { ok: false, code: "IMPORT_FILE_UNREADABLE" };
  }
}

/** Cells copied from Excel / Google Sheets arrive as tab-separated text. */
export function parsePastedText(text: string): ParseOutcome {
  if (new Blob([text]).size > MAX_IMPORT_BYTES) return { ok: false, code: "IMPORT_FILE_TOO_BIG" };
  return finish(rowsFromMatrix(parseCsv(text)), "paste", "Dán từ bảng tính");
}
