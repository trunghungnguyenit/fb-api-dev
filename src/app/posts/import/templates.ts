import type { SheetData } from "write-excel-file/browser";
import { FIELD_LABELS } from "@/lib/import/columns";
import { toCsv } from "@/lib/import/csv";

// Sample files the user can download, fill in and upload again. Generated in the browser.

const HEADER = [FIELD_LABELS.message, FIELD_LABELS.link, FIELD_LABELS.time, FIELD_LABELS.fanpage, FIELD_LABELS.note, FIELD_LABELS.type, FIELD_LABELS.files];

/** A time in the near future (so the sample is valid when uploaded), written the way Vietnamese users type it. */
function sampleTime(daysAhead: number, hour: number) {
  const target = new Date(Date.now() + daysAhead * 86_400_000);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(target);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${String(hour).padStart(2, "0")}:00`;
}

// Columns: message, link, time, fanpage, note, type, files. The rows with files name files the user must pick in the
// import step with exactly these names: rename them to your own files (or delete those rows).
function sampleRows() {
  return [
    ["Chào buổi sáng! Đây là bài mẫu có xuống dòng 🚀\nDòng thứ hai của bài viết.", "https://example.com/bai-viet", sampleTime(2, 8), "", "Chiến dịch tháng 10", "", ""],
    ["Bài này để trống giờ đăng nên sẽ là bản nháp để bạn duyệt.", "", "", "", "", "", ""],
    ["Bài đăng lên một Fanpage khác: ghi đúng tên hoặc ID Fanpage ở cột Fanpage.", "", sampleTime(3, 19), "Tên Fanpage khác", "", "", ""],
    ["Bài có một ảnh (loại bài tự nhận ra từ tệp).", "", "", "", "Mẫu: đổi tên tệp cho đúng tệp của bạn", "", "anh-1.jpg"],
    ["Bài nhiều ảnh: ghi nhiều tên tệp, cách nhau bằng dấu ;", "", "", "", "Mẫu: đổi tên tệp cho đúng tệp của bạn", "", "anh-2.jpg; anh-3.jpg"],
    ["Bài video MP4 hoặc MOV.", "", "", "", "Mẫu: đổi tên tệp cho đúng tệp của bạn", "", "video-1.mp4"],
    ["Reels: video dọc 9:16, ghi “reel” ở cột Loại bài.", "", "", "", "Mẫu: đổi tên tệp cho đúng tệp của bạn", "reel", "reel-1.mp4"]
  ];
}

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV with a UTF-8 BOM so Excel shows Vietnamese correctly. */
export function downloadCsv(fileName: string, rows: (string | number | null | undefined)[][], neutralizeFormulas = false) {
  save(new Blob(["﻿", toCsv(rows, { neutralizeFormulas })], { type: "text/csv;charset=utf-8" }), fileName);
}

export function downloadCsvTemplate() {
  downloadCsv("mau-nhap-bai.csv", [HEADER, ...sampleRows()]);
}

export async function downloadXlsxTemplate() {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const data: SheetData = [
    HEADER.map((value) => ({ value, fontWeight: "bold" as const })),
    ...sampleRows().map((r) => r.map((value) => (value ? value : null)))
  ];
  await writeExcelFile(data, { columns: [{ width: 60 }, { width: 34 }, { width: 20 }, { width: 24 }, { width: 24 }, { width: 14 }, { width: 30 }] }).toFile("mau-nhap-bai.xlsx");
}

export function downloadJsonTemplate() {
  const objects = sampleRows().map(([message, link, time, fanpage, note, type, files]) => ({
    message, ...(link ? { link } : {}), ...(time ? { time } : {}), ...(fanpage ? { fanpage } : {}), ...(note ? { note } : {}),
    ...(type ? { type } : {}), ...(files ? { files: files.split(";").map((f) => f.trim()) } : {})
  }));
  save(new Blob([JSON.stringify(objects, null, 2)], { type: "application/json" }), "mau-nhap-bai.json");
}
