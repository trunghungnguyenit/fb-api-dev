// Small RFC 4180 CSV reader/writer. Posts contain newlines, quotes and emoji, so a naive split(",") is not
// enough. Pure functions, no dependencies: used in the browser (file reading) and in tests.

export type Delimiter = "," | ";" | "\t";

/** Guess the delimiter from the header line (outside quotes): Excel in Vietnamese uses ";", Sheets paste uses tab. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const c of text.replace(/^﻿/, "")) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && c in counts) counts[c as Delimiter]++;
  }
  const best = (Object.keys(counts) as Delimiter[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ",");
  return counts[best] > 0 ? best : ",";
}

/**
 * Parses CSV into rows of cells. Blank rows are KEPT so a row's index is its spreadsheet row number
 * (callers skip empty rows themselves and can still report "dòng 7" correctly).
 */
export function parseCsv(input: string, delimiter: Delimiter = detectDelimiter(input)): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let touched = false; // anything seen on the current row (distinguishes "" at EOF from an empty last line)

  const endRow = () => { row.push(field); rows.push(row); row = []; field = ""; touched = false; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") { inQuotes = true; touched = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; touched = true; continue; }
    if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); continue; }
    if (c === "\n") { endRow(); continue; }
    field += c; touched = true;
  }
  if (touched || field !== "" || row.length) endRow();
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Serialises rows to CSV. With `neutralizeFormulas`, cells that start with = + - @ get a leading apostrophe
 * so that data echoed back from an upload cannot run as a spreadsheet formula when the file is opened.
 */
export function toCsv(rows: (string | number | null | undefined)[][], opts: { delimiter?: Delimiter; neutralizeFormulas?: boolean } = {}) {
  const delimiter = opts.delimiter ?? ",";
  const cell = (value: string | number | null | undefined) => {
    let s = value === null || value === undefined ? "" : String(value);
    if (opts.neutralizeFormulas && typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
    return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(delimiter)).join("\r\n");
}
