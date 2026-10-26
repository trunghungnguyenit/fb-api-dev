// Reading Facebook comments (GET /{post-id}/comments) for display. Pure module: no network, no database.
// Comments are other people's words: they are shown, never stored (only a log of what the user DID is kept).

export type GraphComment = {
  id?: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  like_count?: number;
  comment_count?: number;
  is_hidden?: boolean;
  can_hide?: boolean;
  can_remove?: boolean;
  can_comment?: boolean;
  parent?: { id?: string };
  permalink_url?: string;
  attachment?: { type?: string; url?: string };
  /** Whether the viewer (the Page, with its own token) has liked the comment. */
  user_likes?: boolean;
};

export const COMMENT_FIELDS_FULL =
  "id,message,from{id,name},created_time,like_count,comment_count,is_hidden,can_hide,can_remove,can_comment,parent{id},permalink_url,attachment{type,url},user_likes";
/** Fallback if Facebook refuses a field of the full list. */
export const COMMENT_FIELDS_BASIC = "id,message,from{id,name},created_time,like_count,comment_count";

export const COMMENTS_PAGE_SIZE = 25;
/** Facebook's own limit for the text of a comment. */
export const COMMENT_MAX_LENGTH = 8000;

/** A comment id is digits, with one underscore when it is a comment on a Page post ("<post>_<comment>"). */
export const COMMENT_ID_PATTERN = /^\d{1,30}(_\d{1,30})?$/;

export type CommentView = {
  id: string;
  message: string;
  author: string | null;
  createdTime: string | null;
  likeCount: number | null;
  replyCount: number | null;
  isHidden: boolean;
  /** Facebook did not say = assume allowed (it refuses clearly if not). */
  canHide: boolean;
  canRemove: boolean;
  canReply: boolean;
  /** Written by the Fanpage itself (the only comments the app edits). */
  byPage: boolean;
  /** The Fanpage has liked it; null when Facebook did not say (then the screen must not guess). */
  likedByPage: boolean | null;
  /** The comment this one answers; null for a top-level comment. */
  parentId: string | null;
  attachment: { type: string; url: string | null } | null;
};

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

function webUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { return ["https:", "http:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}

/** One Graph comment as what the page shows. `pageId` is the Fanpage's Facebook id (tells its own comments). null = unusable (no id). */
export function mapComment(g: GraphComment, pageId?: string): CommentView | null {
  if (!g || typeof g.id !== "string" || !COMMENT_ID_PATTERN.test(g.id)) return null;
  const created = g.created_time ? new Date(g.created_time) : null;
  return {
    id: g.id,
    message: typeof g.message === "string" ? g.message : "",
    author: typeof g.from?.name === "string" && g.from.name ? g.from.name : null,
    createdTime: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    likeCount: count(g.like_count),
    replyCount: count(g.comment_count),
    isHidden: g.is_hidden === true,
    canHide: g.can_hide !== false,
    canRemove: g.can_remove !== false,
    canReply: g.can_comment !== false,
    byPage: Boolean(pageId) && g.from?.id === pageId,
    likedByPage: typeof g.user_likes === "boolean" ? g.user_likes : null,
    parentId: typeof g.parent?.id === "string" ? g.parent.id : null,
    attachment: g.attachment && typeof g.attachment.type === "string" ? { type: g.attachment.type, url: webUrl(g.attachment.url) } : null
  };
}

export const mapComments = (list: GraphComment[] | undefined, pageId?: string) =>
  (list ?? []).map((g) => mapComment(g, pageId)).filter((c): c is CommentView => c !== null);
