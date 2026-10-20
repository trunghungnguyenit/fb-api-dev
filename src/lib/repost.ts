// Pure rules for "Đăng lại" (re-posting). No server imports, so the UI and the API share one source of truth.

export type RepostMode = "same_row" | "clone" | "replace";

export type RepostSource = {
  status: string;
  facebook_post_id: string | null;
  facebook_deleted_at: string | null;
  last_error_code: string | null;
};

/** At most this many re-posts per original post per Fanpage within 24 hours (anti-spam, anti double click). */
export const REPOST_LIMIT_PER_DAY = 3;
export const MAX_REPOST_PAGES = 10;
export const MAX_BULK_REPOST = 20;
export const REPOST_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REPOST_MODE_INFO: Record<RepostMode, { label: string; hint: string }> = {
  same_row: {
    label: "Đăng lại trên cùng bài này",
    hint: "Đưa chính bài này vào hàng đợi lần nữa. Mã bài Facebook mới sẽ ghi đè mã cũ (mã cũ vẫn nằm trong lịch sử đăng)."
  },
  clone: {
    label: "Tạo bản sao mới",
    hint: "Tạo bài mới từ nội dung này. Bài hiện tại giữ nguyên, cả hai đều theo dõi, sửa, xóa được."
  },
  replace: {
    label: "Thay thế: đăng bản mới rồi xóa bài cũ trên Facebook",
    hint: "Làm mới bài đang còn trên Fanpage. Bài cũ chỉ bị xóa sau khi bản mới đăng thành công và mất toàn bộ lượt thích, bình luận."
  }
};

export function isLiveOnFacebook(p: RepostSource) {
  return p.status === "published" && !p.facebook_deleted_at;
}

/** Which ways of re-posting make sense for a post in this state. The first one is the default. */
export function repostModes(p: RepostSource): RepostMode[] {
  switch (p.status) {
    case "published":
      if (p.facebook_deleted_at) return ["same_row", "clone"];
      return p.facebook_post_id ? ["clone", "replace"] : [];
    case "failed":
    case "cancelled":
      return ["same_row", "clone"];
    default:
      return [];
  }
}

/** The family root: re-posts always point at the original, never at another copy. */
export function repostRoot(p: { id: string; reposted_from: string | null }) {
  return p.reposted_from ?? p.id;
}

/** Fanpages that already reached the 24h limit. `counts` = re-posts in the window, per Fanpage. */
export function pagesOverLimit(counts: Map<string, number>, pageIds: string[], limit = REPOST_LIMIT_PER_DAY) {
  return pageIds.filter((id) => (counts.get(id) ?? 0) >= limit);
}

export type RepostWhen = "now" | "draft" | string; // string = ISO schedule time

/** Status + schedule a re-posted row starts with. "now" is a due `scheduled` post, picked up right away. */
export function repostSchedule(when: RepostWhen, now = Date.now()) {
  if (when === "draft") return { status: "draft", scheduled_at: null as string | null };
  if (when === "now") return { status: "scheduled", scheduled_at: new Date(now - 1000).toISOString() };
  return { status: "scheduled", scheduled_at: when };
}
