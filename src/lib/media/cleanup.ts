import { supabaseAdmin } from "@/lib/supabase/admin";
import { removeObjects } from "@/lib/media/storage";

// Storage housekeeping (system job). Two rules, both checked against the database right before anything is deleted:
//  1. An upload that belongs to no post (never attached, or its post was edited / deleted) is removed after 24 hours.
//  2. The files of a post that is published (or cancelled) are removed 7 days later, but only if NO other post that
//     is still alive references the same file (re-posting reuses files). A purged row stays as history of the post.
// A post that is draft, scheduled, publishing or failed never loses its files. Every step can be repeated safely:
// a file that is already gone is not an error, and a failed removal leaves its rows for the next run.

export const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;
export const PUBLISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BATCH = 50;
const DEFAULT_BUDGET_MS = 45_000;

export type CleanupStats = { unattachedRows: number; unattachedFiles: number; purgedFiles: number; errors: number; stoppedEarly: boolean };

type Ref = { id: string; storage_path: string };

/** Which of these files are still referenced by a row other than `exceptIds`. */
async function referencedPaths(paths: string[], exceptIds: string[]) {
  let query = supabaseAdmin.from("post_media").select("storage_path").in("storage_path", paths);
  if (exceptIds.length) query = query.not("id", "in", `(${exceptIds.join(",")})`);
  const { data, error } = await query;
  if (error) throw error;
  return new Set(((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path));
}

async function sweepUnattached(now: Date, deadline: number, stats: CleanupStats) {
  const cutoff = new Date(now.getTime() - UNATTACHED_TTL_MS).toISOString();
  while (Date.now() < deadline) {
    const { data, error } = await supabaseAdmin.from("post_media").select("id,storage_path")
      .is("post_id", null).lt("created_at", cutoff).order("created_at", { ascending: true }).limit(BATCH);
    if (error) throw error;
    const batch = (data ?? []) as Ref[];
    if (!batch.length) return;

    const ids = batch.map((r) => r.id);
    const paths = [...new Set(batch.map((r) => r.storage_path))];
    const stillUsed = await referencedPaths(paths, ids);
    const unused = paths.filter((p) => !stillUsed.has(p));

    const failed = new Set<string>();
    if (unused.length) {
      try { await removeObjects(unused); stats.unattachedFiles += unused.length; }
      catch (e) {
        // Keep the rows of these files so the next run retries them; delete the rest.
        console.error("media cleanup: removing files failed:", e);
        stats.errors++;
        unused.forEach((p) => failed.add(p));
      }
    }
    const deletable = batch.filter((r) => !failed.has(r.storage_path)).map((r) => r.id);
    if (!deletable.length) return; // nothing could be removed this time: do not spin on the same rows
    const { error: deleteError } = await supabaseAdmin.from("post_media").delete().in("id", deletable).is("post_id", null);
    if (deleteError) throw deleteError;
    stats.unattachedRows += deletable.length;
  }
  stats.stoppedEarly = true;
}

type PostInfo = { id: string; status: string; published_at: string | null; updated_at: string };

/** Only a published or cancelled post, old enough, lets go of its files. Anything alive keeps them. */
export function releasesFiles(post: PostInfo | undefined, now: Date) {
  if (!post) return false;
  const cutoff = now.getTime() - PUBLISHED_TTL_MS;
  if (post.status === "published") return post.published_at !== null && new Date(post.published_at).getTime() < cutoff;
  if (post.status === "cancelled") return new Date(post.updated_at).getTime() < cutoff;
  return false;
}

async function purgeFinishedPosts(now: Date, deadline: number, stats: CleanupStats) {
  const cutoff = new Date(now.getTime() - PUBLISHED_TTL_MS).toISOString();
  // Files only older than the retention window can belong to a post that released them, so younger rows are skipped.
  let after: { at: string; id: string } | null = null;
  while (Date.now() < deadline) {
    let query = supabaseAdmin.from("post_media").select("id,storage_path,created_at")
      .eq("state", "uploaded").not("post_id", "is", null).lt("created_at", cutoff);
    if (after) query = query.or(`created_at.gt.${after.at},and(created_at.eq.${after.at},id.gt.${after.id})`);
    const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(BATCH);
    if (error) throw error;
    const batch = (data ?? []) as (Ref & { created_at: string })[];
    if (!batch.length) return;
    const last = batch[batch.length - 1];
    after = { at: last.created_at, id: last.id };

    const paths = [...new Set(batch.map((r) => r.storage_path))];
    // Every live row that uses these files, with the post each belongs to.
    const { data: refData, error: refError } = await supabaseAdmin.from("post_media")
      .select("storage_path,post_id").in("storage_path", paths).eq("state", "uploaded");
    if (refError) throw refError;
    const refs = (refData ?? []) as { storage_path: string; post_id: string | null }[];
    const postIds = [...new Set(refs.map((r) => r.post_id).filter((id): id is string => Boolean(id)))];
    const { data: postData, error: postError } = postIds.length
      ? await supabaseAdmin.from("posts").select("id,status,published_at,updated_at").in("id", postIds)
      : { data: [], error: null };
    if (postError) throw postError;
    const posts = new Map(((postData ?? []) as PostInfo[]).map((p) => [p.id, p]));

    for (const path of paths) {
      const users = refs.filter((r) => r.storage_path === path);
      // A row with no post is an upload still waiting to be used: the file stays until that is settled.
      if (!users.every((r) => r.post_id && releasesFiles(posts.get(r.post_id), now))) continue;
      try {
        await removeObjects([path]);
        const { error: markError } = await supabaseAdmin.from("post_media")
          .update({ state: "purged", purged_at: now.toISOString() }).eq("storage_path", path).eq("state", "uploaded");
        if (markError) throw markError;
        stats.purgedFiles++;
      } catch (e) {
        console.error(`media cleanup: purging ${path} failed:`, e);
        stats.errors++;
      }
    }
  }
  stats.stoppedEarly = true;
}

export async function cleanupMedia(opts: { now?: Date; budgetMs?: number } = {}): Promise<CleanupStats> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const stats: CleanupStats = { unattachedRows: 0, unattachedFiles: 0, purgedFiles: 0, errors: 0, stoppedEarly: false };
  await sweepUnattached(now, deadline, stats);
  await purgeFinishedPosts(now, deadline, stats);
  return stats;
}
