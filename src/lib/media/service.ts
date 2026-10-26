import { one, rows, userDb } from "@/lib/db";
import type { ErrorCode } from "@/lib/errors";
import { mediaLimits } from "@/lib/media/config";
import { MAX_UNATTACHED_UPLOADS, type MediaKind, type MediaLimits } from "@/lib/media/limits";
import { checkDeclaredFile, checkMediaSet, checkStoredFile, derivePostType, isAllowedMime, safeFileName, type PostType } from "@/lib/media/rules";
import { createUploadTarget, mediaPath, readHead, removeObjects, statObject } from "@/lib/media/storage";

type Db = ReturnType<typeof userDb>;

export type MediaRow = {
  id: string; post_id: string | null; kind: MediaKind; storage_path: string; file_name: string | null; mime: string;
  size_bytes: number | null; position: number; facebook_media_id: string | null;
  state: "pending" | "uploaded" | "failed" | "purged";
};
const COLUMNS = "id,post_id,kind,storage_path,file_name,mime,size_bytes,position,facebook_media_id,state";

/** A rejected request, with the user-facing text (numbers already filled in) and an HTTP status. */
export type MediaProblem = { code: ErrorCode; message?: string; status: number };
const problem = (code: ErrorCode, status: number, message?: string): { ok: false; problem: MediaProblem } => ({ ok: false, problem: { code, status, message } });

// ---- 1. Before the upload: validate what the client says, then hand out a signed upload URL -------------------

export type UploadRequest = { kind: MediaKind; mime: string; size: number; name?: string };

export async function issueUpload(userId: string, input: UploadRequest, limits: MediaLimits = mediaLimits) {
  const declared = checkDeclaredFile(input, limits);
  if (!declared.ok) return problem(declared.code, declared.code === "MEDIA_TOO_LARGE" ? 413 : 400, declared.message);
  if (!isAllowedMime(input.kind, input.mime)) return problem("MEDIA_TYPE_INVALID", 400);

  const db = userDb(userId);
  const { count, error: countError } = await db.media.select("id", { count: "exact", head: true }).is("post_id", null).in("state", ["pending", "uploaded"]);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_UNATTACHED_UPLOADS) return problem("RATE_LIMITED", 429);

  const id = crypto.randomUUID();
  const path = mediaPath(userId, id, safeFileName(input.name, input.mime));
  const { error } = await db.media.insert({
    id, kind: input.kind, storage_path: path, file_name: input.name?.slice(0, 200) ?? null, mime: input.mime, state: "pending"
  });
  if (error) throw error;
  try {
    const target = await createUploadTarget(path);
    return { ok: true as const, mediaId: id, uploadUrl: target.url, path };
  } catch (e) {
    await db.media.delete().eq("id", id);
    console.error("issueUpload: could not create a signed upload URL:", e);
    return problem("MEDIA_STORAGE_ERROR", 502);
  }
}

// ---- 2. After the upload: look at what really arrived ------------------------------------------------------------

export async function confirmUpload(userId: string, mediaId: string, limits: MediaLimits = mediaLimits) {
  const db = userDb(userId);
  const { data, error } = await db.media.select(COLUMNS).eq("id", mediaId).maybeSingle();
  if (error) throw error;
  const row = one<MediaRow>(data);
  if (!row) return problem("MEDIA_NOT_FOUND", 404);
  if (row.state === "uploaded") return { ok: true as const, media: row }; // confirming twice is harmless
  if (row.state !== "pending") return problem("MEDIA_NOT_UPLOADED", 409);

  let stored, head: Uint8Array;
  try {
    stored = await statObject(row.storage_path);
    head = stored ? await readHead(row.storage_path, 16) : new Uint8Array();
  } catch (e) {
    console.error(`confirmUpload: reading ${row.storage_path} failed:`, e);
    return problem("MEDIA_STORAGE_ERROR", 502);
  }
  if (!stored) return problem("MEDIA_NOT_UPLOADED", 409);

  const check = checkStoredFile({ kind: row.kind, declaredMime: row.mime, actualSize: stored.size, head }, limits);
  if (!check.ok) {
    // Rejected: the file must not stay in storage, and the row records why it is unusable.
    await removeObjects([row.storage_path]).catch((e) => console.error("confirmUpload: removing a rejected file failed:", e));
    await db.media.update({ state: "failed", size_bytes: stored.size }).eq("id", row.id);
    return problem(check.code, check.code === "MEDIA_TOO_LARGE" ? 413 : 422, check.message);
  }
  const { data: updated, error: updateError } = await db.media
    .update({ state: "uploaded", size_bytes: stored.size, uploaded_at: new Date().toISOString() })
    .eq("id", row.id).eq("state", "pending").select(COLUMNS).maybeSingle();
  if (updateError) throw updateError;
  return { ok: true as const, media: one<MediaRow>(updated) ?? { ...row, state: "uploaded" as const, size_bytes: stored.size } };
}

// ---- A file nobody attached: the user removed it from the form ---------------------------------------------------

/** True when another row still points at this file (re-posting shares files), so it must not be deleted yet. */
export async function fileStillReferenced(db: Db, path: string, exceptIds: string[]) {
  let query = db.media.select("id", { count: "exact", head: true }).eq("storage_path", path);
  if (exceptIds.length) query = query.not("id", "in", `(${exceptIds.join(",")})`);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function discardMedia(userId: string, mediaId: string) {
  const db = userDb(userId);
  const { data, error } = await db.media.select(COLUMNS).eq("id", mediaId).maybeSingle();
  if (error) throw error;
  const row = one<MediaRow>(data);
  if (!row) return problem("MEDIA_NOT_FOUND", 404);
  if (row.post_id) return problem("MEDIA_IN_USE", 409);
  const { data: deleted, error: deleteError } = await db.media.delete().eq("id", row.id).is("post_id", null).select("id");
  if (deleteError) throw deleteError;
  if (!deleted?.length) return problem("MEDIA_IN_USE", 409);
  try {
    if (!(await fileStillReferenced(db, row.storage_path, []))) await removeObjects([row.storage_path]);
  } catch (e) {
    // The row is gone; the file is left for the cleanup job's storage sweep rather than failing the request.
    console.error(`discardMedia: removing ${row.storage_path} failed:`, e);
  }
  return { ok: true as const };
}

// ---- 3. Putting uploaded files on a post -------------------------------------------------------------------------

/** One entry of a post's media list: an uploaded file to attach, or (`clone`) a file of another post to copy. */
export type MediaRef = { id: string; clone?: boolean };

export type ResolvedMedia = { refs: MediaRef[]; rows: MediaRow[]; postType: PostType };

/**
 * Checks that these refs can become the media of a post (that does not exist yet, or `ownPostId`): they exist,
 * are the user's, are fully uploaded, fit the per-post limits, and do not come with a link. Nothing is changed.
 */
export async function resolveMedia(
  db: Db, refs: MediaRef[], opts: { linkUrl?: string | null; ownPostId?: string; limits?: MediaLimits }
): Promise<{ ok: true; value: ResolvedMedia } | { ok: false; problem: MediaProblem }> {
  const limits = opts.limits ?? mediaLimits;
  if (new Set(refs.map((r) => r.id)).size !== refs.length) return problem("INVALID_REQUEST", 400);
  if (refs.length && opts.linkUrl) return problem("MEDIA_WITH_LINK", 400);
  if (!refs.length) return { ok: true, value: { refs, rows: [], postType: derivePostType({ linkUrl: opts.linkUrl, media: [] }) } };

  const { data, error } = await db.media.select(COLUMNS).in("id", refs.map((r) => r.id));
  if (error) throw error;
  const byId = new Map(rows<MediaRow>(data).map((r) => [r.id, r]));
  const ordered: MediaRow[] = [];
  for (const ref of refs) {
    const row = byId.get(ref.id);
    if (!row) return problem("MEDIA_NOT_FOUND", 404);
    if (row.state === "purged") return problem("MEDIA_PURGED", 409);
    if (row.state !== "uploaded" || row.size_bytes === null) return problem("MEDIA_NOT_UPLOADED", 409);
    if (ref.clone) {
      if (!row.post_id) return problem("MEDIA_NOT_FOUND", 404); // only files that belong to a post can be copied
    } else if (row.post_id && row.post_id !== opts.ownPostId) {
      return problem("MEDIA_IN_USE", 409);
    }
    ordered.push(row);
  }
  const set = checkMediaSet(ordered.map((r) => ({ kind: r.kind, size: r.size_bytes as number })), limits);
  if (!set.ok) return problem(set.code, 400, set.message);
  return { ok: true, value: { refs, rows: ordered, postType: derivePostType({ linkUrl: opts.linkUrl, media: ordered }) } };
}

export class MediaConflict extends Error {}

/**
 * Makes `refs` the media of the post, in that order: attaches uploads, copies cloned files, and only then detaches
 * files that were on the post but are no longer listed (the cleanup job removes them later).
 * All or nothing: if anything fails (MediaConflict when a file was taken by someone else in the meantime, or a
 * database error) what this call changed is put back, so the post keeps the media it had and no file is orphaned.
 */
export async function applyMedia(db: Db, postId: string, resolved: ResolvedMedia) {
  const { refs, rows: files } = resolved;
  const keep = new Set(refs.filter((r) => !r.clone).map((r) => r.id));

  const { data: current, error } = await db.media.select("id,position").eq("post_id", postId);
  if (error) throw error;
  const before = rows<{ id: string; position: number }>(current).map((r) => ({ id: r.id, position: r.position }));

  const taken: string[] = []; // free uploads this call attached
  const copies: string[] = []; // rows this call inserted for cloned files
  const moved = new Map<string, number>(); // files already on the post whose position this call changed -> old position

  try {
    for (let i = 0; i < refs.length; i++) {
      const file = files[i];
      if (refs[i].clone) {
        const copyId = crypto.randomUUID();
        const { error: insertError } = await db.media.insert({
          id: copyId, post_id: postId, kind: file.kind, storage_path: file.storage_path, file_name: file.file_name, mime: file.mime,
          size_bytes: file.size_bytes, position: i, state: "uploaded", uploaded_at: new Date().toISOString()
        });
        if (insertError) throw insertError;
        copies.push(copyId);
        // The cleanup job flips a file to `purged` before deleting it: if that happened meanwhile, the copy would point at nothing.
        const { data: source, error: sourceError } = await db.media.select("id").eq("id", file.id).eq("state", "uploaded");
        if (sourceError) throw sourceError;
        if (!source?.length) throw new MediaConflict(file.id);
      } else {
        // Only a file that is still free (or already on this post) may be taken.
        const { data: updated, error: updateError } = await db.media.update({ post_id: postId, position: i })
          .eq("id", file.id).eq("state", "uploaded").or(`post_id.is.null,post_id.eq.${postId}`).select("id");
        if (updateError) throw updateError;
        if (!updated?.length) throw new MediaConflict(file.id);
        const previous = before.find((b) => b.id === file.id);
        if (previous) moved.set(file.id, previous.position); else taken.push(file.id);
      }
    }
    const detach = before.map((b) => b.id).filter((id) => !keep.has(id));
    if (detach.length) {
      const { error: detachError } = await db.media.update({ post_id: null, position: 0 }).in("id", detach);
      if (detachError) throw detachError;
    }
  } catch (e) {
    await undoApply(db, { taken, copies, moved });
    throw e;
  }
}

/** Best effort: puts back what a failed applyMedia changed. Whatever is missed is left to the cleanup job. */
async function undoApply(db: Db, done: { taken: string[]; copies: string[]; moved: Map<string, number> }) {
  const log = (what: string, error: unknown) => { if (error) console.error(`applyMedia: undoing (${what}) failed:`, error); };
  try {
    if (done.copies.length) log("copies", (await db.media.delete().in("id", done.copies)).error);
    if (done.taken.length) log("attached files", (await db.media.update({ post_id: null, position: 0 }).in("id", done.taken)).error);
    for (const [id, position] of done.moved) log("positions", (await db.media.update({ position }).eq("id", id)).error);
  } catch (e) { log("unexpected", e); }
}

/** The media of the given posts, in display order. */
export async function mediaOfPosts(db: Db, postIds: string[]) {
  const byPost = new Map<string, MediaRow[]>();
  if (!postIds.length) return byPost;
  const { data, error } = await db.media.select(COLUMNS).in("post_id", postIds).order("position", { ascending: true });
  if (error) throw error;
  for (const row of rows<MediaRow>(data)) {
    const list = byPost.get(row.post_id as string) ?? [];
    list.push(row);
    byPost.set(row.post_id as string, list);
  }
  return byPost;
}
