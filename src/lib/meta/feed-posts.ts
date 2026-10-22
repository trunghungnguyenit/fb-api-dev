// Reading a Page's posts from Facebook (GET /{page-id}/posts) and deciding what changed. Pure module: no network,
// no database. The sync job (feed-sync.ts) does the I/O around these functions.

export type GraphAttachment = {
  media_type?: string;
  type?: string;
  url?: string;
  target?: { id?: string };
  subattachments?: { data?: GraphAttachment[] };
};

export type GraphFeedPost = {
  id?: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  status_type?: string;
  attachments?: { data?: GraphAttachment[] };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
};

/** Full read: text, link, attachments (with target ids, to recognise this app's own posts) and engagement counts. */
export const FEED_FIELDS_FULL =
  "id,message,created_time,permalink_url,status_type,"
  + "attachments{media_type,type,url,target{id},subattachments{media_type,type,url,target{id}}},"
  + "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";

/** Fallback if Facebook refuses the fields above for this Page / API version: the post itself, no extras. */
export const FEED_FIELDS_BASIC = "id,message,created_time,permalink_url,status_type";

/** Every sync looks at this much history (a rolling window); older rows are kept but no longer refreshed. */
export const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How often each Fanpage's posts are read: FEED_SYNC_INTERVAL_MIN minutes (default 5, between 1 and 60; checked at startup in env.ts). */
export function feedSyncIntervalMs(raw: string | undefined = process.env.FEED_SYNC_INTERVAL_MIN) {
  const minutes = Number(raw);
  return (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 5) * 60 * 1000;
}
export const SYNC_INTERVAL_MS = feedSyncIntervalMs();
const SYNC_JITTER_MS = Math.min(2 * 60 * 1000, Math.floor(SYNC_INTERVAL_MS / 5));
/** A post this close to the window's edge may legitimately have just scrolled out of it: never judged "missing". */
const EDGE_MARGIN_MS = 60 * 60 * 1000;

export const windowStart = (now: Date) => new Date(now.getTime() - SYNC_WINDOW_MS);

/** When the next sync of a Page is due: the interval plus a random spread, so thousands of Pages do not all fall on one minute. */
export const nextSyncAfter = (now: Date, random: number = Math.random()) =>
  new Date(now.getTime() + SYNC_INTERVAL_MS + Math.floor(random * SYNC_JITTER_MS));

export type FeedMedia = { type: string; url: string | null; target_id: string | null };

export type MappedFeedPost = {
  facebook_post_id: string;
  message: string;
  permalink_url: string | null;
  status_type: string | null;
  created_time: string;
  media: FeedMedia[];
  reactions_count: number | null;
  comments_count: number | null;
  shares_count: number | null;
  /** Every id this post can be known by on Facebook: its own, and the objects attached to it (photo / video ids). */
  link_keys: string[];
};

/** Facebook links only: a stored URL ends up in an `href`, so anything else (javascript:, other hosts) is dropped. */
export function facebookUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const absolute = url.startsWith("/") ? `https://www.facebook.com${url}` : url;
  try {
    const parsed = new URL(absolute);
    const host = parsed.hostname;
    return parsed.protocol === "https:" && (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com"))
      ? parsed.toString() : null;
  } catch { return null; }
}

/** A link to anywhere on the web, http(s) only. */
function webUrl(url: string | undefined): string | null {
  if (!url) return null;
  try { return ["https:", "http:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}

const MAX_MEDIA = 10;

function flatten(attachments: GraphAttachment[] | undefined, out: FeedMedia[], keys: Set<string>) {
  for (const a of attachments ?? []) {
    if (out.length >= MAX_MEDIA) return;
    const targetId = a.target?.id ?? null;
    if (targetId) keys.add(targetId);
    const children = a.subattachments?.data;
    if (children?.length) flatten(children, out, keys);
    else out.push({ type: a.media_type ?? a.type ?? "link", url: webUrl(a.url), target_id: targetId });
  }
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/**
 * One Graph post as a database row. null = unusable (no id, or no valid time).
 * `engagement`: the request asked for reactions / comments / shares. Facebook leaves `shares` out when nobody shared
 * the post, so with engagement requested a missing `shares` means 0; without it the numbers are simply unknown.
 */
export function mapFeedPost(g: GraphFeedPost, opts: { engagement?: boolean } = {}): MappedFeedPost | null {
  if (!g || typeof g.id !== "string" || !g.id) return null;
  const created = g.created_time ? new Date(g.created_time) : null;
  if (!created || Number.isNaN(created.getTime())) return null;

  const media: FeedMedia[] = [];
  const keys = new Set<string>([g.id]);
  flatten(g.attachments?.data, media, keys);

  return {
    facebook_post_id: g.id,
    message: typeof g.message === "string" ? g.message : "",
    permalink_url: facebookUrl(g.permalink_url),
    status_type: typeof g.status_type === "string" ? g.status_type : null,
    created_time: created.toISOString(),
    media,
    reactions_count: count(g.reactions?.summary?.total_count),
    comments_count: count(g.comments?.summary?.total_count),
    shares_count: opts.engagement ? (count(g.shares?.count) ?? 0) : count(g.shares?.count),
    link_keys: [...keys]
  };
}

export type KnownFeedRow = { id: string; facebook_post_id: string; created_time: string; absent_checks: number; missing_since: string | null };

/**
 * After a COMPLETE read of the window, which stored posts did Facebook not return? A post is only believed gone
 * after two such reads in a row (one read can miss a post for reasons that pass), and posts at the window's edge
 * are never judged. Returns the rows to bump once, and the rows now confirmed missing.
 */
export function planAbsences(known: KnownFeedRow[], seen: ReadonlySet<string>, since: Date) {
  const floor = since.getTime() + EDGE_MARGIN_MS;
  const firstMiss: string[] = [];
  const confirmed: string[] = [];
  for (const row of known) {
    if (seen.has(row.facebook_post_id)) continue;
    if (new Date(row.created_time).getTime() < floor) continue;
    if (row.missing_since) continue; // already known to be gone
    if (row.absent_checks >= 1) confirmed.push(row.id); else firstMiss.push(row.id);
  }
  return { firstMiss, confirmed };
}
