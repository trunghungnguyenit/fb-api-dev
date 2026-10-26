import { rows, userDb } from "@/lib/db";
import { processDuePosts } from "@/lib/publisher";
import { FUNCTION_LIMIT_MS } from "@/lib/publish-state";
import { REPOST_WINDOW_MS, repostSchedule, type RepostWhen } from "@/lib/repost";

type Db = ReturnType<typeof userDb>;

export const POST_COLUMNS =
  "id,page_id,message,link_url,status,scheduled_at,published_at,facebook_post_id,last_error_code,edited_at,facebook_deleted_at,reposted_from,created_at,updated_at";

export type PostOut = {
  id: string; page_id: string; status: string; last_error_code: string | null; facebook_deleted_at: string | null;
};

export type CountSource = { id: string; root: string; page_id: string };

/**
 * Re-posts in the last 24h, per original post (root) and Fanpage:
 * copies created from the root, plus in-place re-posts (`republished` events) of each source row.
 */
export async function recentRepostCounts(db: Db, sources: CountSource[]) {
  const counts = new Map<string, Map<string, number>>();
  const bump = (root: string, pageId: string) => {
    const perPage = counts.get(root) ?? new Map<string, number>();
    perPage.set(pageId, (perPage.get(pageId) ?? 0) + 1);
    counts.set(root, perPage);
  };
  if (!sources.length) return counts;
  const since = new Date(Date.now() - REPOST_WINDOW_MS).toISOString();
  const roots = [...new Set(sources.map((s) => s.root))];

  const [copies, events] = await Promise.all([
    db.posts.select("reposted_from,page_id").in("reposted_from", roots).gte("created_at", since),
    db.events.select("post_id").eq("type", "republished").in("post_id", sources.map((s) => s.id)).gte("created_at", since)
  ]);
  if (copies.error) throw copies.error;
  if (events.error) throw events.error;
  for (const c of rows<{ reposted_from: string; page_id: string }>(copies.data)) bump(c.reposted_from, c.page_id);
  const bySource = new Map(sources.map((s) => [s.id, s]));
  for (const e of rows<{ post_id: string }>(events.data)) {
    const s = bySource.get(e.post_id);
    if (s) bump(s.root, s.page_id);
  }
  return counts;
}

export type CloneItem = { root: string; pageId: string; message: string; linkUrl: string | null; postType: string };

/** One new row per item, each pointing at its original post. Returns the inserted rows. */
export async function insertClones(db: Db, items: CloneItem[], when: RepostWhen) {
  const schedule = repostSchedule(when);
  const { data, error } = await db.posts.insert(items.map((item) => ({
    page_id: item.pageId, message: item.message, link_url: item.linkUrl, post_type: item.postType, reposted_from: item.root, ...schedule
  }))).select(POST_COLUMNS);
  if (error) throw error;
  return rows<PostOut>(data);
}

/**
 * Publishes the given posts one after another, but stops starting new ones once `budgetMs` has passed
 * (one publish can take up to 30s and the request must stay under the 60s function limit). Posts that were
 * not reached stay `scheduled` and are picked up by the scheduler / cron.
 */
export async function publishInline(ids: string[], budgetMs = 25_000) {
  const started = Date.now();
  for (const id of ids) {
    if (Date.now() - started > budgetMs) break;
    // Every post shares the request's one function limit, not 60 s each.
    try { await processDuePosts({ postId: id, deadline: started + FUNCTION_LIMIT_MS - 3_000 }); }
    catch (e) { console.error(`inline publish failed for ${id}:`, e); }
  }
}

export async function fetchPosts(db: Db, ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await db.posts.select(POST_COLUMNS).in("id", ids);
  if (error) throw error;
  const byId = new Map(rows<PostOut>(data).map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter((p): p is PostOut => Boolean(p));
}
