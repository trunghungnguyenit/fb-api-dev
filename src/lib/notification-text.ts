// Pure module (safe for client and server): turns a stored notification into Vietnamese text. Only codes and a
// few parameters are stored, never Meta's raw text, so what users read always comes from here.
import { messageFor } from "@/lib/errors";

export const NOTIFICATION_TYPES = [
  "PUBLISH_FAILED", "PUBLISH_AMBIGUOUS", "PAGE_ACCESS_LOST", "REAUTH_REQUIRED", "TOKEN_EXPIRING", "SCOPES_MISSING", "POST_DELETED_ON_FACEBOOK"
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationParams = { connectionName?: string; days?: number; features?: string[] };

export type NotificationRow = {
  id?: string;
  type: string;
  code?: string | null;
  params?: NotificationParams | null;
  page_id?: string | null;
  post_id?: string | null;
};

/**
 * One key per distinct event, so repeating the same event (a retried job, a daily re-check) never notifies twice,
 * while a NEW event of the same kind (the post fails again after a manual retry) does.
 */
export const dedupeKeys = {
  publishFailed: (postId: string, attempt: number) => `publish-failed:${postId}:${attempt}`,
  publishAmbiguous: (postId: string) => `publish-ambiguous:${postId}`,
  /** At most once per Page per day: a Page that loses access, is reconnected and loses it again still gets told. */
  pageAccessLost: (pageRowId: string, day: string) => `page-lost:${pageRowId}:${day}`,
  reauthRequired: (connectionId: string, day: string) => `reauth:${connectionId}:${day}`,
  /** One per warning level (7/3/1 days) per expiry date, so a renewed token warns again when ITS end approaches. */
  tokenExpiring: (connectionId: string, daysBucket: number, expiryDay: string) => `token-expiring:${connectionId}:${expiryDay}:${daysBucket}`,
  /** Sent when a permission is taken back, so once per day at most; the same set can be reported again after a re-grant. */
  scopesMissing: (connectionId: string, features: string[], day: string) => `scopes-missing:${connectionId}:${[...features].sort().join("+")}:${day}`,
  /** One per deletion: a post that comes back and is deleted again is a new event (a new `since`). */
  postDeleted: (postId: string, since: string) => `post-deleted:${postId}:${since}`
};

export type NotificationText = { title: string; detail: string; href: string };

export function describeNotification(n: NotificationRow, pageName?: string | null): NotificationText {
  const page = pageName ? ` trên ${pageName}` : "";
  const pageLabel = pageName ?? "Fanpage";
  const connection = n.params?.connectionName ? ` (${n.params.connectionName})` : "";
  const postHref = n.post_id ? `/posts/${n.post_id}` : "/posts";

  switch (n.type) {
    case "PUBLISH_FAILED":
      return { title: `Đăng bài thất bại${page}`, detail: messageFor(n.code, "PUBLISH_FAILED"), href: postHref };
    case "PUBLISH_AMBIGUOUS":
      return { title: `Chưa rõ bài đã được đăng chưa${page}`, detail: messageFor("AMBIGUOUS"), href: postHref };
    case "PAGE_ACCESS_LOST":
      return {
        title: `${pageLabel} đã mất quyền truy cập`,
        detail: "Fanpage đã bị tắt vì mất quyền (token hết hạn hoặc bạn không còn là quản trị viên). Các bài đã lên lịch vẫn được giữ và sẽ tự đăng sau khi bạn kết nối lại Facebook.",
        href: "/pages"
      };
    case "REAUTH_REQUIRED":
      return {
        title: `Cần xác thực lại Facebook${connection}`,
        detail: "Kết nối Facebook không còn hợp lệ nên các Fanpage thuộc kết nối này chưa đăng được bài. Hãy bấm “Kết nối Facebook” ở trang Fanpage để cấp quyền lại.",
        href: "/pages"
      };
    case "TOKEN_EXPIRING": {
      const days = Math.max(0, Math.round(n.params?.days ?? 0));
      return {
        title: `Quyền truy cập dữ liệu sắp hết hạn${connection}`,
        detail: `Quyền truy cập dữ liệu của kết nối Facebook sẽ hết hạn sau khoảng ${days} ngày. Hãy kết nối lại Facebook trước thời điểm đó để các Fanpage không bị gián đoạn.`,
        href: "/pages"
      };
    }
    case "SCOPES_MISSING": {
      const features = (n.params?.features ?? []).join(", ");
      return {
        title: `${pageName ?? (n.params?.connectionName ? `Kết nối Facebook${connection}` : "Fanpage")} cần cấp thêm quyền`,
        detail: `${features ? `Để dùng ${features}, hãy` : "Hãy"} kết nối lại Facebook và tích chọn tất cả các quyền được yêu cầu.`,
        href: "/pages"
      };
    }
    case "POST_DELETED_ON_FACEBOOK":
      return {
        title: `Bài đã bị xóa trên Facebook${page}`,
        detail: "Bài này không còn trên Fanpage (đã bị xóa hoặc ẩn trực tiếp trên Facebook). Ứng dụng giữ lại bản ghi và đánh dấu “Đã xóa trên Facebook”; nếu bài hiện lại, nhãn sẽ tự được gỡ.",
        href: postHref
      };
    default:
      return { title: "Thông báo", detail: "", href: "/" };
  }
}
