import { messageFor } from "@/lib/errors";

const STATUS_LABELS: Record<string, string> = {
  draft: "Nháp", scheduled: "Đã lên lịch", publishing: "Đang đăng",
  published: "Đã đăng", failed: "Lỗi", cancelled: "Đã hủy"
};

/** Server components run in the host's timezone (UTC on Vercel), so pin the display zone. */
export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

export function statusLabel(status: string, deletedOnFacebook = false) {
  if (deletedOnFacebook) return "Đã xóa trên Facebook";
  return STATUS_LABELS[status] ?? status;
}

export const STATUS_FILTERS: { value: string; label: string }[] = [
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
  { value: "deleted", label: "Đã xóa trên Facebook" }
];

const EVENT_LABELS: Record<string, string> = {
  edited: "Đã sửa nội dung trên Facebook",
  edit_failed: "Sửa nội dung trên Facebook thất bại",
  deleted_on_facebook: "Đã xóa bài trên Facebook",
  delete_failed: "Xóa bài trên Facebook thất bại",
  detected_missing: "Phát hiện bài không còn trên Facebook",
  detected_live: "Bài xuất hiện trở lại trên Facebook",
  marked_deleted: "Đã đánh dấu bài đã xóa trên Facebook",
  republished: "Đã đăng lại bài này"
};

export function eventLabel(type: string) {
  return EVENT_LABELS[type] ?? "Sự kiện";
}

const OUTCOME_LABELS: Record<string, string> = {
  started: "Đang xử lý", success: "Thành công", failure: "Thất bại", ambiguous: "Chưa rõ kết quả"
};

/** One line for a publish attempt. Meta's raw error text is never shown. */
export function attemptText(outcome: string, errorCode: string | null) {
  const base = OUTCOME_LABELS[outcome] ?? outcome;
  if (outcome === "success" || outcome === "started" || !errorCode) return base;
  if (errorCode === "INTERRUPTED") return `${base}: bị gián đoạn trước khi gửi, đã đưa lại vào hàng đợi`;
  return `${base}: ${messageFor(errorCode, "PUBLISH_FAILED")}`;
}

/** Link to a published post on Facebook, from the `{pageId}_{postId}` id Graph returns. */
export function facebookPostUrl(facebookPostId: string) {
  return `https://www.facebook.com/${encodeURIComponent(facebookPostId)}`;
}

/** Message for a post's stored error. Raw backend/Meta text from older rows is never shown. */
export function postErrorText(code: string | null | undefined) {
  return code ? messageFor(code, "PUBLISH_FAILED") : null;
}

const TASK_LABELS: Record<string, string> = {
  CREATE_CONTENT: "Tạo nội dung", MANAGE: "Quản lý", MODERATE: "Kiểm duyệt", ADVERTISE: "Quảng cáo",
  ANALYZE: "Xem thống kê", MESSAGING: "Nhắn tin", MANAGE_JOBS: "Quản lý tuyển dụng", MANAGE_LEADS: "Quản lý khách hàng tiềm năng"
};

/** Vietnamese label for a Page task; unknown tasks are shown as Meta names them. */
export function taskLabel(task: string) {
  return TASK_LABELS[task] ?? task;
}

/** Truncates by code point, so emoji are never cut in half. */
export function truncate(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
