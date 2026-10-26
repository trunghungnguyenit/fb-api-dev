/** The columns of a post that may be sent to the browser (an allowlist for queries; `publicPost` below is the second line of defence). */
export const POST_PUBLIC_COLUMNS =
  "id,page_id,message,link_url,status,post_type,publish_phase,scheduled_at,published_at,edited_at,facebook_post_id,facebook_deleted_at,reposted_from,import_batch_id,note,last_error_code,created_at,updated_at";

// A post as the browser may receive it. The database row also holds what only the server needs (who holds the lock, how many
// attempts, Facebook's raw error text, timestamps of internal checks); the screens use none of it (the detail page reads what it
// shows from its own query), and Facebook's wording must never reach a user, so it is taken out before any answer leaves the server.
// The screens use `last_error_code` and the catalog.

const INTERNAL = [
  "user_id", "last_error_message", "locked_at", "attempt_count", "sent_at", "next_attempt_at", "processing_since", "phase_checked_at", "facebook_checked_at"
] as const;

export function publicPost<T>(row: T): T {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const copy = { ...(row as Record<string, unknown>) };
  for (const key of INTERNAL) delete copy[key];
  return copy as T;
}

export const publicPosts = <T>(rows: T[] | null | undefined): T[] => (rows ?? []).map(publicPost);
