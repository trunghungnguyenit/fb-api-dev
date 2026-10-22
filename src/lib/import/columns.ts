// Turns whatever the user uploaded (CSV, Excel, pasted cells, JSON) into one shape: RawRow[].
// Header names are matched loosely (case, accents and punctuation ignored, English or Vietnamese).

export type ImportField = "message" | "link" | "time" | "fanpage" | "note" | "type" | "files";

/** One spreadsheet row as plain text. `line` is the row number the user sees (header = 1). */
export type RawRow = { line: number; message: string; link: string; time: string; fanpage: string; note: string; type: string; files: string };

export const IMPORT_FIELDS: ImportField[] = ["message", "link", "time", "fanpage", "note", "type", "files"];

/** Vietnamese labels used for the template header and the error report. */
export const FIELD_LABELS: Record<ImportField, string> = {
  message: "Nội dung", link: "Liên kết", time: "Thời gian đăng", fanpage: "Fanpage", note: "Ghi chú", type: "Loại bài", files: "Tệp đính kèm"
};

const ALIASES: Record<ImportField, string[]> = {
  message: ["noidung", "noidungbaiviet", "baiviet", "message", "content", "caption", "text", "body"],
  link: ["lienket", "link", "url", "linkurl", "duongdan"],
  time: ["thoigiandang", "giodang", "thoigian", "lichdang", "ngaydang", "ngaygio", "schedule", "scheduledat", "time", "datetime", "date"],
  fanpage: ["fanpage", "tenfanpage", "page", "pagename", "pageid", "idfanpage", "trang"],
  note: ["ghichu", "nhan", "note", "notes", "label", "tag", "chiendich", "campaign"],
  type: ["loaibai", "loai", "type", "posttype", "kind", "dinhdang"],
  files: ["tepdinhkem", "tep", "tepanhvideo", "dinhkem", "files", "file", "filename", "filenames", "media", "anh", "hinhanh", "tepanh"]
};

/** lower-case, no accents, only letters and digits: "Thời gian đăng" -> "thoigiandang". */
export function normalizeHeader(header: string) {
  return header.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldFor(header: string): ImportField | null {
  const key = normalizeHeader(header);
  return IMPORT_FIELDS.find((f) => ALIASES[f].includes(key)) ?? null;
}

/** Any cell value (string, number, boolean, Date from xlsx) as trimmed text. Excel dates have no zone: read their wall-clock parts. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).replace(/\r\n?/g, "\n").trim();
}

export type ParsedRows =
  | { ok: true; rows: RawRow[]; ignoredColumns: string[] }
  | { ok: false; reason: "empty" | "no_message_column" };

/** A matrix (first non-empty row = header). Blank rows are skipped but keep their original line numbers. */
export function rowsFromMatrix(matrix: unknown[][]): ParsedRows {
  const headerIndex = matrix.findIndex((r) => r.some((c) => cellToString(c) !== ""));
  if (headerIndex < 0) return { ok: false, reason: "empty" };

  const header = matrix[headerIndex].map(cellToString);
  const columns = new Map<ImportField, number>();
  const ignored: string[] = [];
  header.forEach((h, i) => {
    if (!h) return;
    const f = fieldFor(h);
    if (f && !columns.has(f)) columns.set(f, i);
    else ignored.push(h);
  });
  // A photo or video needs no caption, so the file column alone is enough to import.
  if (!columns.has("message") && !columns.has("files")) return { ok: false, reason: "no_message_column" };

  const rows: RawRow[] = [];
  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i].map(cellToString);
    if (cells.every((c) => c === "")) continue;
    const get = (f: ImportField) => (columns.has(f) ? cells[columns.get(f)!] ?? "" : "");
    rows.push({ line: i + 1, message: get("message"), link: get("link"), time: get("time"), fanpage: get("fanpage"), note: get("note"), type: get("type"), files: get("files") });
  }
  return { ok: true, rows, ignoredColumns: ignored };
}

/** JSON: an array of objects (or {posts: [...]}); keys use the same loose names as spreadsheet headers. */
export function rowsFromJson(data: unknown): ParsedRows {
  const list = Array.isArray(data) ? data : Array.isArray((data as { posts?: unknown })?.posts) ? (data as { posts: unknown[] }).posts : null;
  if (!list || list.length === 0) return { ok: false, reason: "empty" };

  const rows: RawRow[] = [];
  const ignored = new Set<string>();
  let sawMessage = false;
  list.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return;
    const row: RawRow = { line: index + 1, message: "", link: "", time: "", fanpage: "", note: "", type: "", files: "" };
    for (const [key, value] of Object.entries(item)) {
      const f = fieldFor(key);
      if (!f) { ignored.add(key); continue; }
      if (f === "message" || f === "files") sawMessage = true;
      // "files" may be a list of names in JSON.
      row[f] = Array.isArray(value) ? value.map(cellToString).filter(Boolean).join(";") : cellToString(value);
    }
    rows.push(row);
  });
  if (!sawMessage) return { ok: false, reason: "no_message_column" };
  return { ok: true, rows, ignoredColumns: [...ignored] };
}
