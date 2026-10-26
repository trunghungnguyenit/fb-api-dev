// What other people leave on a Fanpage: posts they wrote on its wall (GET /{page-id}/visitor_posts) and their ratings
// (GET /{page-id}/ratings). Pure module: no network, no database. Both are other people's words: they are shown on demand and
// never stored (only a number, the count of ratings, is kept to tell when new ones arrive).

export const GUEST_PAGE_SIZE = 20;

/** A visitor post id is "<page id>_<post id>". */
export const VISITOR_POST_ID_PATTERN = /^\d{1,30}_\d{1,30}$/;

/** A paging cursor from Facebook: only the cursor goes to the browser and back, never a URL (which carries the token). */
export const CURSOR_PATTERN = /^[\w=-]{1,500}$/;

export type GraphVisitorPost = {
  id?: string;
  message?: string;
  story?: string;
  created_time?: string;
  permalink_url?: string;
  from?: { id?: string; name?: string };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
};

export const VISITOR_FIELDS_FULL =
  "id,message,story,created_time,permalink_url,from{id,name},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
/** Fallback if Facebook refuses a field of the full list. */
export const VISITOR_FIELDS_BASIC = "id,message,story,created_time,permalink_url,from{id,name}";

export type VisitorPostView = {
  /** "<page id>_<post id>". */
  id: string;
  message: string;
  author: string | null;
  createdTime: string | null;
  permalinkUrl: string | null;
  reactions: number | null;
  comments: number | null;
};

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

function webUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { return ["https:", "http:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}

function isoOrNull(value: unknown): string | null {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** One Graph visitor post as what the page shows. null = unusable (no id). */
export function mapVisitorPost(g: GraphVisitorPost): VisitorPostView | null {
  if (!g || typeof g.id !== "string" || !VISITOR_POST_ID_PATTERN.test(g.id)) return null;
  return {
    id: g.id,
    // A post with no words of its own (a shared link, a photo) may still have Facebook's one-line story of it.
    message: typeof g.message === "string" && g.message ? g.message : typeof g.story === "string" ? g.story : "",
    author: typeof g.from?.name === "string" && g.from.name ? g.from.name : null,
    createdTime: isoOrNull(g.created_time),
    permalinkUrl: webUrl(g.permalink_url),
    reactions: count(g.reactions?.summary?.total_count),
    comments: count(g.comments?.summary?.total_count)
  };
}

export const mapVisitorPosts = (list: GraphVisitorPost[] | undefined) =>
  (list ?? []).map(mapVisitorPost).filter((p): p is VisitorPostView => p !== null);

// ---- Ratings -----------------------------------------------------------------------------------------------------------

export type GraphRating = {
  created_time?: string;
  has_rating?: boolean;
  has_review?: boolean;
  rating?: number;
  recommendation_type?: string;
  review_text?: string;
  reviewer?: { id?: string; name?: string };
};

export const RATING_FIELDS_FULL = "created_time,has_rating,has_review,rating,recommendation_type,review_text,reviewer{id,name}";
export const RATING_FIELDS_BASIC = "created_time,rating,recommendation_type,review_text";

export type RatingView = {
  /** Ratings have no id of their own: reviewer + time tell them apart. */
  key: string;
  reviewer: string | null;
  createdTime: string | null;
  /** 1-5 stars (the older kind of rating); null when this one is a recommendation. */
  stars: number | null;
  /** The newer kind: recommends (positive) or not (negative). */
  recommendation: "positive" | "negative" | null;
  text: string;
};

/** One Graph rating as what the page shows. null = nothing to show (no stars, no recommendation, no text). */
export function mapRating(g: GraphRating, index = 0): RatingView | null {
  if (!g || typeof g !== "object") return null;
  const stars = typeof g.rating === "number" && Number.isInteger(g.rating) && g.rating >= 1 && g.rating <= 5 ? g.rating : null;
  const recommendation = g.recommendation_type === "positive" || g.recommendation_type === "negative" ? g.recommendation_type : null;
  const text = typeof g.review_text === "string" ? g.review_text : "";
  if (stars === null && recommendation === null && !text) return null;
  const createdTime = isoOrNull(g.created_time);
  return {
    key: `${g.reviewer?.id ?? "anon"}:${createdTime ?? index}:${index}`,
    reviewer: typeof g.reviewer?.name === "string" && g.reviewer.name ? g.reviewer.name : null,
    createdTime, stars, recommendation, text
  };
}

export const mapRatings = (list: GraphRating[] | undefined) =>
  (list ?? []).map((g, i) => mapRating(g, i)).filter((r): r is RatingView => r !== null);

/** The Page's own totals: how many ratings, and the average of the stars (null when it has none or Facebook did not say). */
export type RatingSummary = { count: number | null; average: number | null };

export function mapRatingSummary(g: { rating_count?: unknown; overall_star_rating?: unknown } | null | undefined): RatingSummary {
  const average = typeof g?.overall_star_rating === "number" && g.overall_star_rating > 0 && g.overall_star_rating <= 5 ? g.overall_star_rating : null;
  return { count: count(g?.rating_count), average };
}
