import { rows, type userDb } from "@/lib/db";
import { mediaLimits } from "@/lib/media/config";
import { formatMb, type MediaKind, type MediaLimits } from "@/lib/media/limits";
import { checkMediaSet } from "@/lib/media/rules";
import { applyMedia, discardMedia, fileStillReferenced, resolveMedia, type MediaProblem, type MediaRef } from "@/lib/media/service";
import { removeObjects } from "@/lib/media/storage";
import type { ValidatedRow } from "./validate";

type Db = ReturnType<typeof userDb>;

/** A rejected import, with the user-facing reason and an HTTP status. */
export class ImportProblem extends Error {
  constructor(public problem: MediaProblem) { super(problem.code); }
}

const CONCURRENCY = 6;
const IN_USE_TEXT = "Một tệp đã tải lên đang gắn với bài khác. Hãy quay lại bước xem trước và nhập lại.";

type Item = { id: string; row: ValidatedRow };
type StoredMedia = { id: string; kind: MediaKind; state: string; post_id: string | null; size_bytes: number | null };

/** Runs `task` over `items` a few at a time and, if any fails, waits for the others to finish before throwing the first failure. */
async function inChunks<T>(items: T[], task: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(task));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
  }
}

/**
 * Checks, before any post exists, that every file the rows need was uploaded by this user, is whole, is not on a
 * post already, was uploaded as the kind the row needs (a Reel is not a video), and that every post and the whole
 * import stay within the limits. Sizes here are the ones Storage measured, not the ones the browser claimed.
 */
async function preflight(db: Db, toImport: ValidatedRow[], uploaded: Map<string, string>, limits: MediaLimits) {
  if (new Set(uploaded.values()).size !== uploaded.size) throw new ImportProblem({ code: "INVALID_REQUEST", status: 400 });
  const need = new Map<string, MediaKind>(); // media id -> kind it must have
  for (const r of toImport) {
    if (!r.mediaKind) continue;
    for (const key of r.fileKeys) {
      const id = uploaded.get(key);
      if (!id) throw new ImportProblem({ code: "IMPORT_MEDIA_NOT_UPLOADED", status: 422 });
      need.set(id, r.mediaKind);
    }
  }
  if (!need.size) return;
  const { data, error } = await db.media.select("id,kind,state,post_id,size_bytes").in("id", [...need.keys()]);
  if (error) throw error;
  const found = new Map(rows<StoredMedia>(data).map((m) => [m.id, m]));
  let total = 0;
  for (const [id, kind] of need) {
    const m = found.get(id);
    if (!m) throw new ImportProblem({ code: "MEDIA_NOT_FOUND", status: 404 });
    if (m.state !== "uploaded" || m.size_bytes === null) throw new ImportProblem({ code: "IMPORT_MEDIA_NOT_UPLOADED", status: 422 });
    if (m.post_id) throw new ImportProblem({ code: "MEDIA_IN_USE", status: 409, message: IN_USE_TEXT });
    if (m.kind !== kind) throw new ImportProblem({ code: "MEDIA_MISMATCH", status: 422 });
    total += m.size_bytes;
  }
  if (total > limits.importTotalBytes) {
    throw new ImportProblem({ code: "MEDIA_TOTAL_TOO_LARGE", status: 400, message: `Tổng dung lượng tệp của một lần nhập tối đa ${formatMb(limits.importTotalBytes)}.` });
  }
  // Each post's own files against the per-post limits, by the real sizes: so a failure shows up before anything is created.
  for (const r of toImport) {
    if (!r.mediaKind) continue;
    const set = checkMediaSet(r.fileKeys.map((k) => ({ kind: r.mediaKind as MediaKind, size: (found.get(uploaded.get(k) as string) as StoredMedia).size_bytes as number })), limits);
    if (!set.ok) throw new ImportProblem({ code: set.code, status: 400, message: `Dòng ${r.line}: ${set.message}` });
  }
}

/**
 * Creates the posts of an import. Every post is first created as a draft, so nothing can be published before the whole
 * batch is known to be good; the files are attached; and only then are the posts with a time scheduled. If anything
 * fails, the whole batch is taken back. `uploaded`: fileKey -> media id of the file the browser uploaded.
 */
export async function createImportedPosts(
  db: Db, userId: string, batchId: string, toImport: ValidatedRow[], uploaded: Map<string, string>, limits: MediaLimits = mediaLimits
) {
  await preflight(db, toImport, uploaded, limits);

  const needed = new Set(toImport.flatMap((r) => r.fileKeys.map((k) => uploaded.get(k) as string)));
  const items: Item[] = toImport.map((row) => ({ id: crypto.randomUUID(), row }));
  const { error: insertError } = await db.posts.insert(items.map(({ id, row }) => ({
    id, page_id: row.pageId, message: row.message, link_url: row.linkUrl, post_type: row.postType,
    status: "draft", scheduled_at: null, note: row.note, import_batch_id: batchId
  })));
  if (insertError) throw insertError;

  try {
    await attachAll(db, items.filter((i) => i.row.mediaKind), uploaded, limits);
    await inChunks(items.filter((i) => i.row.scheduledAt), async ({ id, row }) => {
      const { data, error } = await db.posts.update({ status: "scheduled", scheduled_at: row.scheduledAt, updated_at: new Date().toISOString() })
        .eq("id", id).eq("status", "draft").select("id");
      if (error) throw error;
      if (!data?.length) throw new Error(`post ${id} could not be scheduled`);
    });
  } catch (e) {
    await takeBack(db, userId, batchId, needed);
    throw e;
  }
  // Uploads the browser made for rows that are no longer imported (changed since the preview) are not kept.
  await Promise.all([...uploaded.values()].filter((id) => !needed.has(id)).map((id) => discardMedia(userId, id).catch(() => undefined)));
  return items.length;
}

/**
 * Attaches the files. A file is attached to the first post that uses it and copied for the others (one upload, one
 * stored file, one row per post). Posts whose files nobody used before are independent and run a few at a time;
 * the others depend on an earlier post, so they go one by one in file order.
 */
async function attachAll(db: Db, items: Item[], uploaded: Map<string, string>, limits: MediaLimits) {
  const seen = new Set<string>();
  const independent: Item[] = [];
  const dependent: Item[] = [];
  for (const item of items) {
    (item.row.fileKeys.some((k) => seen.has(k)) ? dependent : independent).push(item);
    item.row.fileKeys.forEach((k) => seen.add(k));
  }

  const attached = new Set<string>(); // media ids that already belong to a post
  const attach = async ({ id, row }: Item) => {
    const refs: MediaRef[] = row.fileKeys.map((k) => {
      const mediaId = uploaded.get(k) as string;
      return attached.has(mediaId) ? { id: mediaId, clone: true } : { id: mediaId };
    });
    const resolved = await resolveMedia(db, refs, { linkUrl: null, ownPostId: id, limits });
    if (!resolved.ok) throw new ImportProblem(resolved.problem);
    await applyMedia(db, id, resolved.value);
    refs.forEach((r) => attached.add(r.id));
  };

  await inChunks(independent, attach);
  for (const item of dependent) await attach(item);
}

/**
 * Undoes a failed import: the files attached to its posts (the originals and the copies) go with the posts, so
 * nothing is left counting against the user's unattached uploads, and files nobody references any more leave Storage.
 * Best effort: whatever is missed is caught by the cleanup job.
 */
async function takeBack(db: Db, userId: string, batchId: string, uploadedIds: Set<string>) {
  const { data: postData, error: postError } = await db.posts.select("id").eq("import_batch_id", batchId);
  if (postError) console.error(`import ${batchId}: listing the posts of a failed import failed:`, postError);
  const postIds = rows<{ id: string }>(postData).map((p) => p.id);

  let paths: string[] = [];
  if (postIds.length) {
    const { data: mediaData } = await db.media.select("id,storage_path").in("post_id", postIds);
    const attachedRows = rows<{ id: string; storage_path: string }>(mediaData);
    const { error } = attachedRows.length ? await db.media.delete().in("id", attachedRows.map((m) => m.id)) : { error: null };
    if (error) console.error(`import ${batchId}: removing the files of a failed import failed:`, error);
    else paths = [...new Set(attachedRows.map((m) => m.storage_path))];
  }

  const { error } = await db.posts.delete().eq("import_batch_id", batchId);
  if (error) console.error(`import ${batchId}: removing the posts of a failed import failed:`, error);
  const { error: batchError } = await db.imports.delete().eq("id", batchId);
  if (batchError) console.error(`import ${batchId}: removing the batch of a failed import failed:`, batchError);

  for (const path of paths) {
    try { if (!(await fileStillReferenced(db, path, []))) await removeObjects([path]); }
    catch (e) { console.error(`import ${batchId}: removing ${path} failed:`, e); }
  }
  // Uploads that never got attached.
  for (const id of uploadedIds) await discardMedia(userId, id).catch(() => undefined);
}
