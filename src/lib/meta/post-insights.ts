// Insights of ONE post (GET /{post-id}/insights?period=lifetime). Pure module (safe for client and server): which numbers
// the post page shows and how Facebook's answer becomes something to show. Meta retires post metrics as it does Page
// metrics, so nothing here assumes a metric exists: the loader (lib/post-insights.ts) asks for each one and a refusal is
// reported for that metric alone.

export type PostMetricKey = "mediaViews" | "viewers" | "clicks" | "videoViews" | "watchTime" | "avgWatch" | "reelsPlays";

/** What kind of post this is decides which numbers exist for it: a video or Reel has its own (watch time...), a plain post has clicks. */
export type PostVariant = "post" | "video" | "reel";

export type PostMetricDef = {
  key: PostMetricKey;
  /** The metric's name in the Graph API. */
  graph: string;
  label: string;
  hint: string;
  unit: string;
  /** "duration": the value is milliseconds and is shown as a length of time, not as a count. */
  format?: "duration";
};

export const POST_METRICS: readonly PostMetricDef[] = [
  { key: "mediaViews", graph: "post_media_view", label: "Lượt xem nội dung", unit: "lượt", hint: "Số lần nội dung của bài được xem." },
  { key: "viewers", graph: "post_total_media_view_unique", label: "Người xem duy nhất", unit: "người", hint: "Số người khác nhau đã xem bài." },
  { key: "clicks", graph: "post_clicks", label: "Lượt nhấp", unit: "lượt", hint: "Số lần người xem nhấp vào bài (liên kết, ảnh, xem thêm…)." }
];

const MEDIA_VIEWS: PostMetricDef = POST_METRICS[0];
const VIEWERS: PostMetricDef = POST_METRICS[1];

/** The numbers of a video: views and viewers like any post, plus how long it was watched. */
export const VIDEO_METRICS: readonly PostMetricDef[] = [
  MEDIA_VIEWS, VIEWERS,
  { key: "videoViews", graph: "post_video_views", label: "Lượt xem video", unit: "lượt", hint: "Số lần video được xem (Facebook tính từ vài giây trở lên)." },
  { key: "watchTime", graph: "post_video_view_time", label: "Tổng thời gian xem", unit: "", format: "duration", hint: "Tổng thời gian mọi người đã xem video." },
  { key: "avgWatch", graph: "post_video_avg_time_watched", label: "Thời gian xem trung bình", unit: "", format: "duration", hint: "Trung bình mỗi lượt xem, người xem đã xem video bao lâu." }
];

/** A Reel adds the number of times it was played. */
export const REEL_METRICS: readonly PostMetricDef[] = [
  ...VIDEO_METRICS,
  { key: "reelsPlays", graph: "blue_reels_play_count", label: "Lượt phát Reels", unit: "lượt", hint: "Số lần Reels được phát." }
];

export const metricsFor = (variant: PostVariant): readonly PostMetricDef[] => (variant === "reel" ? REEL_METRICS : variant === "video" ? VIDEO_METRICS : POST_METRICS);

/** 3725000 -> "1 giờ 2 phút"; 205000 -> "3 phút 25 giây"; 12500 -> "12,5 giây". Never more than two units. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  const tenths = Math.round(seconds * 10) / 10;
  if (tenths < 60) return `${tenths.toLocaleString("vi-VN")} giây`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return m > 0 ? `${h} giờ ${m} phút` : `${h} giờ`;
  return s > 0 ? `${m} phút ${s} giây` : `${m} phút`;
}

/** What Facebook gave for one metric: a number. */
export type RawPostValue = number;
export type PostValue = { total: number };

/**
 * Facebook's body -> for each metric it answered, its (lifetime) value; null when it gave none. Several `values` entries
 * mean several periods: the last one is the latest. Entries it cannot use are skipped.
 */
export function parsePostInsights(body: unknown): Map<string, RawPostValue | null> {
  const out = new Map<string, RawPostValue | null>();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const name = (entry as { name?: unknown })?.name;
    const values = (entry as { values?: unknown })?.values;
    if (typeof name !== "string" || !Array.isArray(values)) continue;
    const value = (values[values.length - 1] as { value?: unknown } | undefined)?.value;
    out.set(name, typeof value === "number" && Number.isFinite(value) ? value : null);
  }
  return out;
}

export function postValue(raw: RawPostValue | null | undefined): PostValue | null {
  return raw === null || raw === undefined ? null : { total: raw };
}
