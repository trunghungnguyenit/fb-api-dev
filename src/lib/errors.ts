// Pure module (safe for client and server). Technical details go to server logs only;
// users get a Vietnamese message plus a short reference code they can quote to support.

export const ERROR_MESSAGES = {
  UNAUTHENTICATED: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  LOGIN_FAILED: "Đăng nhập Google thất bại. Vui lòng thử lại.",
  INVALID_REQUEST: "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại và thử lại.",
  SCHEDULE_REQUIRED: "Vui lòng chọn thời gian đăng để lên lịch.",
  POST_NOT_FOUND: "Không tìm thấy bài viết, hoặc bài viết không thuộc tài khoản của bạn.",
  POST_STATE_INVALID: "Chỉ có thể sửa bài nháp, bài đã lên lịch hoặc bài bị lỗi.",
  POST_LOCKED: "Bài viết vừa đổi trạng thái (đang được đăng). Hãy tải lại trang rồi thử lại.",
  PAGE_NOT_FOUND: "Fanpage không tồn tại, đã bị tắt hoặc không thuộc tài khoản của bạn.",
  PAGE_INACTIVE: "Fanpage này đang bị tắt (mất quyền). Bài được giữ trong hàng đợi và sẽ tự đăng khi bạn kết nối lại Facebook ở trang Fanpage.",
  SCHEDULE_IN_PAST: "Thời gian đăng đã qua. Hãy chọn thời gian trong tương lai hoặc dùng “Đăng ngay”.",
  FB_PERMISSION_DENIED: "Facebook từ chối quyền đăng bài này. Hãy kiểm tra quyền quản trị Fanpage và trạng thái ứng dụng Facebook (chế độ Live, đã được duyệt pages_manage_posts) rồi thử lại.",
  PAGE_PERMISSION_LOST: "Fanpage đã mất quyền đăng bài (token hết hạn hoặc bạn không còn là quản trị viên). Hãy kết nối lại Facebook ở trang Fanpage.",
  TOKEN_DECRYPT_FAILED: "Không đọc được thông tin kết nối đã lưu của Fanpage. Hãy kết nối lại Facebook ở trang Fanpage.",
  DB_ERROR: "Hệ thống đang gặp sự cố khi lưu hoặc tải dữ liệu. Vui lòng thử lại sau ít phút.",
  NETWORK: "Không kết nối được máy chủ. Hãy kiểm tra mạng và thử lại.",
  UNEXPECTED: "Đã xảy ra lỗi không mong muốn. Vui lòng thử lại.",
  FORBIDDEN: "Yêu cầu bị từ chối.",
  OAUTH_STATE_INVALID: "Phiên kết nối Facebook đã hết hạn hoặc không hợp lệ. Vui lòng bấm “Kết nối Facebook” lại.",
  FB_OAUTH_DENIED: "Bạn đã từ chối cấp quyền trên Facebook, nên chưa thể kết nối Fanpage.",
  FB_TOKEN_EXCHANGE_FAILED: "Facebook không cấp được quyền truy cập dài hạn. Vui lòng thử kết nối lại.",
  FB_CONNECT_FAILED: "Kết nối Facebook thất bại. Vui lòng thử lại sau.",
  POST_NOT_EDITABLE: "Không thể sửa bài viết ở trạng thái hiện tại.",
  EDIT_PUBLISHED_FIELDS: "Sau khi đã đăng lên Facebook chỉ sửa được nội dung chữ. Muốn đổi liên kết, Fanpage hoặc giờ đăng, hãy nhân bản bài rồi đăng lại.",
  EDIT_NO_CHANGE: "Nội dung không thay đổi so với bản hiện tại.",
  POST_NOT_DELETABLE: "Không thể xóa bài viết ở trạng thái hiện tại.",
  POST_ALREADY_DELETED: "Bài này đã bị xóa trên Facebook.",
  POST_NO_FACEBOOK_ID: "Bài này chưa có mã bài trên Facebook nên không thể thao tác trên Facebook. Hãy kiểm tra Fanpage trước.",
  FB_POST_GONE: "Bài không còn tồn tại trên Facebook (đã bị xóa hoặc ẩn). Trạng thái đã được cập nhật.",
  FB_EDIT_REJECTED: "Facebook không cho sửa bài này (loại bài hoặc trạng thái bài không hỗ trợ chỉnh sửa).",
  FB_DELETE_NOT_ALLOWED: "Facebook không cho xóa bài này qua ứng dụng. Hãy mở bài trên Facebook để xóa, rồi bấm “Đánh dấu đã xóa trên Facebook”.",
  FB_STILL_LIVE: "Bài vẫn còn trên Facebook. Hãy xóa bài trên Facebook trước rồi thử lại.",
  REPOST_NOT_ALLOWED: "Bài ở trạng thái này không thể đăng lại, hoặc cách đăng lại không phù hợp.",
  REPOST_LIMIT: "Bài này đã được đăng lại quá số lần cho phép trong 24 giờ. Vui lòng thử lại sau.",
  CONFIRM_DUPLICATE_LIVE: "Bài gốc vẫn còn trên Facebook. Đăng lại sẽ tạo bài trùng nội dung và Facebook có thể coi là spam. Hãy xác nhận nếu vẫn muốn đăng.",
  REPLACE_NEEDS_DELETE_FIRST: "Facebook từ chối đăng vì bài trùng với bài cũ còn trên Fanpage. Cần xóa bài cũ trước rồi mới đăng bản mới.",
  REPLACE_OLD_NOT_DELETED: "Đã đăng bản mới nhưng chưa xóa được bài cũ trên Facebook. Hãy xóa bài cũ thủ công.",
  REPLACE_NOW_ONLY: "Thay thế bài luôn đăng ngay. Hãy chọn “Đăng ngay” hoặc dùng cách đăng lại khác.",
  REPOST_LIVE_BULK: "Bài vẫn còn trên Facebook nên không đăng lại hàng loạt. Hãy đăng lại từng bài để xác nhận.",
  TOO_MANY_PAGES: "Chọn tối đa 10 Fanpage cho mỗi lần đăng lại.",
  BULK_LIMIT: "Mỗi lần chỉ thao tác tối đa 50 bài.",
  FB_SCOPES_MISSING: "Bạn chưa cấp đủ quyền cho ứng dụng (cần quyền xem danh sách Fanpage và đăng bài). Hãy kết nối lại và tích chọn tất cả các quyền được yêu cầu.",
  RATE_LIMITED: "Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.",
  QUEUE_FULL: "Bạn đang có quá nhiều bài nháp hoặc bài đã lên lịch (tối đa 500). Hãy hủy bớt trước khi tạo thêm.",
  FB_CHECK_FAILED: "Không kiểm tra được quyền Fanpage lúc này. Vui lòng thử lại sau.",
  FB_RATE_LIMITED: "Facebook đang giới hạn số lượt gọi. Vui lòng thử lại sau ít phút.",
  FB_TEMP_BLOCKED: "Facebook tạm thời chặn đăng bài từ Fanpage này (nghi ngờ spam). Hãy thử lại sau.",
  FB_DUPLICATE: "Facebook từ chối vì nội dung trùng với bài vừa đăng. Hãy sửa lại nội dung.",
  FB_CONTENT_REJECTED: "Facebook không chấp nhận nội dung hoặc liên kết của bài viết. Hãy kiểm tra lại nội dung và liên kết.",
  FB_UNAVAILABLE: "Facebook đang gặp sự cố tạm thời. Vui lòng thử lại sau.",
  FB_REJECTED: "Facebook từ chối bài đăng. Vui lòng kiểm tra lại nội dung và quyền của Fanpage.",
  PUBLISH_FAILED: "Đăng bài thất bại. Vui lòng thử lại.",
  AMBIGUOUS: "Chưa rõ bài đã được đăng hay chưa (quá trình đăng bị gián đoạn). Hãy kiểm tra Fanpage trước khi đăng lại, vì bài có thể đã lên Facebook."
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, value);
}

/**
 * Message for a stored/transported code. Unknown codes (old rows, forged query strings) never leak raw
 * text: they become `fallback` (UNEXPECTED by default; PUBLISH_FAILED in post contexts).
 */
export function messageFor(code: string | null | undefined, fallback: ErrorCode = "UNEXPECTED"): string {
  return code && isErrorCode(code) ? ERROR_MESSAGES[code] : ERROR_MESSAGES[fallback];
}

export function newRef(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

export const REF_PATTERN = /^[A-Z0-9]{6,12}$/;

export function withRef(message: string, ref?: string | null): string {
  return ref && REF_PATTERN.test(ref) ? `${message} (Mã tham chiếu: ${ref})` : message;
}

/** Logs the technical detail server-side under a reference the user can quote. */
export function logError(code: ErrorCode, ref: string, detail?: unknown, level: "error" | "warn" = "error") {
  console[level](`[${ref}] ${code}`, detail ?? "");
}

/**
 * Throw from a server component for an unexpected failure (e.g. a DB error). Next logs it server-side
 * with a digest and app/error.tsx shows the user a friendly message plus that digest as the reference.
 */
export class AppFailure extends Error {
  constructor(public code: ErrorCode, detail?: unknown) {
    super(`${code}: ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`, { cause: detail });
    this.name = "AppFailure";
  }
}
