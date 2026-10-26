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
  IMPORT_EMPTY: "Không có dòng hợp lệ nào để nhập. Hãy sửa các dòng lỗi trong tệp rồi thử lại.",
  IMPORT_TOO_MANY_ROWS: "Mỗi lần nhập tối đa 100 dòng. Hãy chia tệp thành nhiều phần.",
  IMPORT_SPREAD_PAST: "Giờ bắt đầu dãn lịch đã qua. Hãy chọn một thời điểm trong tương lai.",
  IMPORT_NOT_FOUND: "Không tìm thấy lần nhập này, hoặc nó không thuộc tài khoản của bạn.",
  IMPORT_ALREADY_UNDONE: "Lần nhập này đã được hoàn tác trước đó.",
  IMPORT_PARSE_EMPTY: "Tệp trống hoặc không có dòng dữ liệu nào.",
  IMPORT_PARSE_NO_COLUMN: "Không tìm thấy cột “Nội dung” (hoặc “Tệp đính kèm”) trong tệp. Hãy tải tệp mẫu để xem đúng tên cột.",
  IMPORT_MEDIA_NOT_UPLOADED: "Một số tệp ảnh/video của lần nhập chưa được tải lên. Hãy quay lại bước xem trước và nhập lại.",
  IMPORT_FILE_TOO_BIG: "Tệp lớn quá 1 MB. Hãy chia nhỏ tệp.",
  IMPORT_FILE_UNREADABLE: "Không đọc được tệp này. Hãy dùng CSV, Excel (.xlsx) hoặc JSON đúng định dạng.",
  PAGE_REMOVED: "Đã hủy do bạn gỡ Fanpage này khỏi ứng dụng. Muốn đăng lại, dùng nút “Đăng lại”.",
  // Media. The API replaces the first group's text with one that carries the configured numbers.
  MEDIA_TYPE_INVALID: "Chỉ hỗ trợ ảnh JPG, PNG hoặc GIF hợp lệ.",
  MEDIA_TOO_LARGE: "Ảnh vượt giới hạn dung lượng cho phép.",
  MEDIA_TOO_MANY: "Bài có quá nhiều ảnh.",
  MEDIA_TOTAL_TOO_LARGE: "Tổng dung lượng ảnh của bài vượt giới hạn cho phép.",
  MEDIA_MISMATCH: "Nội dung tệp không khớp với loại ảnh đã khai báo.",
  MEDIA_EMPTY: "Tệp tải lên trống.",
  MEDIA_MIXED: "Một bài chỉ có ảnh, hoặc đúng một video / Reels, không trộn lẫn.",
  FB_VIDEO_FAILED: "Facebook không xử lý được video này (định dạng, độ dài hoặc tỉ lệ khung hình có thể chưa phù hợp, Reels cần video dọc 9:16 dài 3–90 giây). Hãy kiểm tra video rồi thử lại.",
  FB_VIDEO_FETCH_FAILED: "Facebook không tải được tệp video. Vui lòng thử lại; nếu lỗi lặp lại hãy báo quản trị viên.",
  MEDIA_NOT_FOUND: "Không tìm thấy ảnh, hoặc ảnh không thuộc tài khoản của bạn.",
  MEDIA_NOT_UPLOADED: "Ảnh chưa được tải lên xong. Hãy tải ảnh lại.",
  MEDIA_IN_USE: "Ảnh đang được dùng trong một bài viết nên không thể xóa riêng.",
  MEDIA_WITH_LINK: "Bài có ảnh không đăng kèm liên kết được. Hãy bỏ liên kết hoặc bỏ ảnh.",
  MEDIA_PURGED: "Ảnh của bài này đã được dọn khỏi hệ thống nên không dùng lại được. Hãy tải ảnh lên lại.",
  MEDIA_MISSING: "Không tìm thấy tệp ảnh của bài (đã bị xóa hoặc chưa tải lên đầy đủ). Hãy tải ảnh lên lại rồi đăng lại.",
  MEDIA_STORAGE_ERROR: "Không xử lý được tệp ảnh lúc này. Vui lòng thử lại sau.",
  COMMENTS_SCOPES_MISSING: "Chưa cấp quyền quản lý bình luận cho kết nối Facebook này. Hãy kết nối lại Facebook và tích chọn tất cả các quyền được yêu cầu.",
  COMMENTS_PERMISSION_DENIED: "Facebook từ chối quyền với bình luận của Fanpage này. Hãy kết nối lại Facebook, cấp quyền bình luận cho Fanpage này và kiểm tra bạn có quyền kiểm duyệt (Moderate) trên Fanpage.",
  COMMENT_GONE: "Bình luận này không còn tồn tại trên Facebook (đã bị xóa hoặc ẩn khỏi bạn).",
  COMMENTS_UNAVAILABLE: "Bài này chưa có bình luận để xem: bài chưa được đăng hoặc đã bị xóa trên Facebook.",
  COMMENT_NOT_OWN: "Chỉ sửa được bình luận do chính Fanpage viết. Bình luận này là của người khác nên không thể sửa.",
  COMMENT_REJECTED: "Facebook từ chối thao tác với bình luận này. Bình luận có thể đã bị ẩn, bị khóa hoặc không còn cho phép thao tác. Hãy làm mới danh sách bình luận rồi thử lại.",
  GUEST_SCOPES_MISSING: "Chưa cấp quyền đọc nội dung của khách (pages_read_user_content) cho kết nối Facebook này. Hãy kết nối lại Facebook và tích chọn tất cả các quyền được yêu cầu.",
  GUEST_PERMISSION_DENIED: "Facebook từ chối cho ứng dụng đọc bài và đánh giá của khách trên Fanpage này. Hãy kết nối lại Facebook, cấp quyền đọc nội dung của người dùng và kiểm tra bạn có quyền quản trị trên Fanpage. Nếu ứng dụng Facebook đang ở chế độ Development, chỉ người có vai trò trong ứng dụng mới đọc được.",
  GUEST_POSTS_UNAVAILABLE: "Facebook không cho đọc bài của khách trên Fanpage này lúc này. Hãy thử lại sau; nếu lỗi lặp lại, kiểm tra Fanpage có cho khách đăng bài lên tường không.",
  RATINGS_UNAVAILABLE: "Fanpage này không có mục Đánh giá, hoặc Facebook không cho đọc đánh giá của Fanpage này. Hãy bật mục Đánh giá (hoặc Đề xuất) trong cài đặt Fanpage rồi thử lại.",
  REACTIONS_POST_UNAVAILABLE: "Bài này chưa có số liệu cảm xúc: bài chưa được đăng, đã bị xóa trên Facebook hoặc chưa có mã bài trên Facebook.",
  REACTIONS_PERMISSION_DENIED: "Facebook từ chối cho ứng dụng đọc cảm xúc của bài này. Hãy kết nối lại Facebook, cấp quyền đọc tương tác (pages_read_engagement) và kiểm tra bạn có quyền trên Fanpage.",
  INSIGHTS_SCOPES_MISSING: "Kết nối Facebook này chưa được cấp quyền xem thống kê (read_insights). Hãy bấm “Kết nối Facebook” ở trang Fanpage và tích chọn tất cả các quyền được yêu cầu.",
  INSIGHTS_NO_ANALYZE: "Tài khoản Facebook của bạn không có quyền “Xem thống kê” (Analyze) trên Fanpage này. Hãy nhờ quản trị viên Fanpage cấp vai trò có quyền xem thống kê, rồi bấm “Kiểm tra lại quyền” ở trang Fanpage.",
  INSIGHTS_PERMISSION_DENIED: "Facebook từ chối cho ứng dụng xem thống kê của Fanpage này. Hãy kết nối lại Facebook, cấp quyền xem thống kê, và kiểm tra bạn có quyền “Xem thống kê” trên Fanpage. Nếu ứng dụng Facebook đang ở chế độ Development, chỉ người có vai trò trong ứng dụng mới xem được.",
  INSIGHTS_METRIC_UNSUPPORTED: "Facebook không còn hỗ trợ chỉ số này (đã bị ngừng hoặc đổi tên). Các chỉ số khác vẫn hiển thị bình thường.",
  INSIGHTS_POST_UNAVAILABLE: "Bài này chưa có số liệu Insights: bài chưa được đăng, đã bị xóa trên Facebook hoặc chưa có mã bài trên Facebook.",
  INSIGHTS_POST_NO_DATA: "Facebook chưa có số liệu này cho bài. Số liệu cập nhật khoảng 1 lần mỗi ngày nên bài mới đăng có thể chưa có; hãy thử lại sau.",
  INSIGHTS_NO_DATA: "Facebook chưa có dữ liệu cho chỉ số này trong khoảng ngày đã chọn. Số liệu cập nhật khoảng 1 lần mỗi ngày; Fanpage mới hoặc ít hoạt động có thể chưa có số liệu.",
  DEMOGRAPHICS_NO_DATA: "Facebook chưa có số liệu này cho Fanpage. Facebook chỉ cung cấp thông tin người theo dõi khi Fanpage có đủ người theo dõi (thường từ 100 trở lên) và cập nhật khoảng 1 lần mỗi ngày.",
  INSIGHTS_METRIC_FAILED: "Facebook không trả về chỉ số này lúc này. Hãy thử lại sau; nếu lặp lại nhiều lần thì chỉ số có thể đã bị Facebook thay đổi.",
  PAGE_REMOVED_ACTION: "Fanpage này đã được gỡ khỏi ứng dụng nên chưa thể thao tác trên Facebook. Hãy kết nối lại Fanpage ở trang Fanpage.",
  PAGE_HAS_PUBLISHING: "Fanpage đang có bài được đăng lên Facebook. Hãy thử gỡ lại sau ít giây.",
  PAGE_NOT_REMOVED: "Fanpage này chưa được gỡ.",
  PAGE_HAS_POSTS: "Fanpage này vẫn còn bài viết nên không thể xóa hẳn. Hãy giữ lại để lưu lịch sử.",
  PAGE_RESTORE_UNAVAILABLE: "Facebook không còn cho phép ứng dụng truy cập Fanpage này. Hãy kiểm tra quyền quản trị Fanpage của bạn trên Facebook, rồi bấm “Kết nối Facebook” để cấp lại quyền.",
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
