// Pure module (safe for client and server): what is wrong with each field of a form, in Vietnamese. The browser
// checks with these before sending, and the API turns a failed zod parse into the same kind of message per field,
// so a user always learns WHICH field is wrong and why. Nothing here ever carries a backend or Facebook message.
import type { ZodError } from "zod";

/** Field name -> message. Names are the form's own field names (message, link, schedule…). */
export type FieldErrors = Record<string, string>;

export const MESSAGE_MAX = 63_206;
export const NOTE_MAX = 500;
export const LINK_MAX = 2048;
export const REPLY_MAX = 8000;
const PAST_TOLERANCE_MS = 60_000;

const count = (n: number) => n.toLocaleString("vi-VN");

/** The text of a post. `required`: false for a post that has images or a video (a caption is optional then). */
export function checkMessage(text: string, opts: { required: boolean }): string | null {
  if (opts.required && !text.trim()) return "Nhập nội dung bài viết (hoặc chọn ảnh/video để đăng không cần chữ).";
  if (text.length > MESSAGE_MAX) return `Nội dung dài quá ${count(MESSAGE_MAX)} ký tự (đang có ${count(text.length)}).`;
  return null;
}

/** An optional link: http or https only. */
export function checkLink(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (value.length > LINK_MAX) return `Liên kết dài quá ${count(LINK_MAX)} ký tự.`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Liên kết phải bắt đầu bằng http:// hoặc https://.";
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return "Liên kết thiếu tên miền, ví dụ https://ten-mien.com/bai-viet.";
    return null;
  } catch {
    return "Liên kết không hợp lệ. Ví dụ đúng: https://ten-mien.com/bai-viet.";
  }
}

/** A <input type="datetime-local"> value (local time of the browser). Empty is fine unless `required`. */
export function checkSchedule(local: string, nowMs: number, opts: { required: boolean }): string | null {
  if (!local.trim()) return opts.required ? "Chọn ngày và giờ đăng." : null;
  const t = new Date(local).getTime();
  if (Number.isNaN(t)) return "Ngày giờ chưa đúng. Hãy chọn lại bằng bộ chọn ngày giờ.";
  if (t < nowMs - PAST_TOLERANCE_MS) return "Thời gian này đã qua. Chọn một thời điểm trong tương lai, hoặc dùng “Đăng ngay”.";
  return null;
}

export function checkNote(text: string): string | null {
  return text.trim().length > NOTE_MAX ? `Ghi chú dài quá ${count(NOTE_MAX)} ký tự.` : null;
}

/** A reply to a comment. */
export function checkReply(text: string): string | null {
  if (!text.trim()) return "Nhập nội dung trả lời.";
  if (text.length > REPLY_MAX) return `Nội dung trả lời dài quá ${count(REPLY_MAX)} ký tự (đang có ${count(text.length)}).`;
  return null;
}

/** The Fanpages chosen for a re-post. */
export function checkPageSelection(ids: string[], max: number): string | null {
  if (ids.length === 0) return "Chọn ít nhất một Fanpage.";
  if (ids.length > max) return `Chọn tối đa ${max} Fanpage mỗi lần đăng lại.`;
  return null;
}

/** "Đến trang": a whole number from 1 to `total`. */
export function checkJumpPage(raw: string, total: number): { ok: true; page: number } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: false, message: `Nhập số trang từ 1 đến ${count(total)}.` };
  if (!/^\d+$/.test(text)) return { ok: false, message: "Số trang phải là số nguyên, ví dụ 3." };
  const page = Number(text);
  if (page < 1 || page > total) return { ok: false, message: `Chỉ có ${count(total)} trang. Nhập số từ 1 đến ${count(total)}.` };
  return { ok: true, page };
}

/** The first message of a set of field errors (for a one-line summary above the form). */
export function firstMessage(errors: FieldErrors): string | null {
  return Object.values(errors)[0] ?? null;
}

/**
 * Turns a failed zod parse into one Vietnamese message per field, using `labels` for the field names the user sees.
 * Only the first problem of each field is kept.
 */
export function zodFieldErrors(error: ZodError, labels: Record<string, string>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    if (out[key]) continue;
    const label = labels[key] ?? "Dữ liệu";
    const lower = label.charAt(0).toLowerCase() + label.slice(1);
    const raw = issue as { code: string; origin?: string; minimum?: number | bigint; maximum?: number | bigint; format?: string };
    switch (raw.code) {
      case "too_small":
        out[key] = raw.origin === "array" ? `Hãy chọn ít nhất ${Number(raw.minimum)} ${lower}.` : `${label} không được để trống.`;
        break;
      case "too_big":
        out[key] = raw.origin === "array" ? `${label} tối đa ${Number(raw.maximum)} mục.` : `${label} dài quá ${count(Number(raw.maximum))} ký tự.`;
        break;
      case "invalid_type":
        out[key] = `Thiếu ${lower}.`;
        break;
      default:
        out[key] = raw.format === "datetime" ? `${label} chưa đúng định dạng ngày giờ.` : `${label} không hợp lệ.`;
    }
  }
  return out;
}
