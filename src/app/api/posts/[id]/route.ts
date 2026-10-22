import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import type { MediaKind } from "@/lib/media/limits";
import { AMBIGUOUS_CODE, processDuePosts } from "@/lib/publisher";
import { apiError, failureResponse, invalidFields } from "@/lib/api-error";
import { messageFor } from "@/lib/errors";
import { isSameOrigin } from "@/lib/csrf";
import { applyMedia, MediaConflict, resolveMedia, type ResolvedMedia } from "@/lib/media/service";
import { derivePostType } from "@/lib/media/rules";
import {
  deleteFacebookPost, editFacebookMessage, FacebookActionError, isGoneOnFacebook, markFacebookGone, recordEvent
} from "@/lib/facebook-posts";

export const runtime = "nodejs";
export const maxDuration = 60;

const patchSchema = z.object({
  action: z.enum(["cancel", "schedule", "draft", "edit", "mark_deleted"]),
  scheduledAt: z.string().datetime().optional().or(z.literal("")),
  // schedule only: publish right now (used by "Đăng ngay" / "Thử lại").
  publishNow: z.boolean().optional(),
  // Required to re-queue a post whose earlier publish outcome is unknown (it may already be live).
  force: z.boolean().optional(),
  // edit
  // May be empty only for a post that has images (checked in editUnpublished): a photo needs no caption.
  message: z.string().trim().max(63206).optional(),
  linkUrl: z.string().url().refine((v) => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
  pageId: z.string().uuid().optional(),
  // edit (not yet published only): the post's images, in order. Omitted = unchanged.
  media: z.array(z.object({ id: z.string().uuid(), clone: z.boolean().optional() })).max(30).optional(),
  // Private note, kept in this app only (empty string clears it). Editable in every state.
  note: z.string().trim().max(500).optional()
});
type PatchInput = z.infer<typeof patchSchema>;

const EDITABLE = ["draft", "scheduled", "failed"];
const PAST_TOLERANCE_MS = 60_000;
const uuid = z.string().uuid();
// Field names as the edit form calls them (message, link, schedule, note, page, media).
const FIELD_LABELS = { message: "Nội dung bài viết", linkUrl: "Liên kết", scheduledAt: "Thời gian đăng", note: "Ghi chú", pageId: "Fanpage", media: "Tệp đính kèm", action: "Thao tác" };
const FIELD_NAMES = { linkUrl: "link", scheduledAt: "schedule", pageId: "page" };

const COLUMNS = "id,page_id,message,link_url,status,post_type,scheduled_at,published_at,facebook_post_id,last_error_code,edited_at,facebook_deleted_at,note,import_batch_id,created_at,updated_at";

type Existing = {
  id: string; page_id: string; message: string; link_url: string | null; status: string; post_type: string; note: string | null;
  last_error_code: string | null; facebook_post_id: string | null; facebook_deleted_at: string | null;
};
type Db = ReturnType<typeof userDb>;

async function load(db: Db, id: string) {
  const { data, error } = await db.posts
    .select("id,page_id,message,link_url,status,post_type,note,last_error_code,facebook_post_id,facebook_deleted_at").eq("id", id).maybeSingle();
  return { error, post: one<Existing>(data) };
}

const isPast = (iso: string) => new Date(iso).getTime() < Date.now() - PAST_TOLERANCE_MS;

/** After Facebook already accepted a change this write must not be lost, so it is retried. */
async function writeAfterFacebook(db: Db, id: string, patch: Record<string, unknown>) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    const { error } = await db.posts.update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (!error) return true;
    last = error;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  console.error(`DB write after a successful Facebook change failed for post ${id}; reconcile manually:`, last, patch);
  return false;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!uuid.safeParse(id).success) return apiError("POST_NOT_FOUND", 404);
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, FIELD_LABELS, FIELD_NAMES);
  const input = parsed.data;
  const db = userDb(user.id);

  const { error: readError, post: existing } = await load(db, id);
  if (readError) return apiError("DB_ERROR", 500, { detail: readError });
  if (!existing) return apiError("POST_NOT_FOUND", 404);

  if (input.action === "edit") {
    return existing.status === "published"
      ? editPublished(db, user.id, existing, input)
      : editUnpublished(db, existing, input);
  }
  if (input.action === "mark_deleted") return markDeleted(db, user.id, existing);

  // --- status transitions -------------------------------------------------------------------------
  if (!EDITABLE.includes(existing.status)) return apiError("POST_STATE_INVALID", 409);

  // A post whose publish outcome is unknown may already be live: only an explicit `force` may put it
  // back in play, whatever the target (draft or schedule) and whatever its current status.
  if (input.action !== "cancel" && existing.last_error_code === AMBIGUOUS_CODE && !input.force) {
    return apiError("AMBIGUOUS", 409);
  }

  let update: Record<string, unknown>;
  if (input.action === "cancel") {
    update = { status: "cancelled", scheduled_at: null };
  } else if (input.action === "draft") {
    update = { status: "draft", scheduled_at: null, last_error_code: null, last_error_message: null };
  } else if (input.publishNow) {
    update = { status: "scheduled", scheduled_at: new Date(Date.now() - 1000).toISOString(), last_error_code: null, last_error_message: null };
  } else if (input.scheduledAt) {
    if (isPast(input.scheduledAt)) return apiError("SCHEDULE_IN_PAST", 400, { fields: { schedule: messageFor("SCHEDULE_IN_PAST") } });
    update = { status: "scheduled", scheduled_at: input.scheduledAt, last_error_code: null, last_error_message: null };
  } else {
    return apiError("SCHEDULE_REQUIRED", 400);
  }

  // Guard on the status we read: the scheduler may have claimed the post since.
  const { data, error } = await db.posts.update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", existing.status).select(COLUMNS).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  if (!data) return apiError("POST_LOCKED", 409);

  if (input.action === "schedule" && input.publishNow) {
    try { await processDuePosts({ postId: id }); }
    catch (e) { console.error("publishNow (retry) failed:", e); }
    const { data: fresh } = await db.posts.select(COLUMNS).eq("id", id).maybeSingle();
    return NextResponse.json({ post: fresh ?? data });
  }
  return NextResponse.json({ post: data });
}

/** Draft / scheduled / failed: nothing is on Facebook, so every field can change (database only). */
async function editUnpublished(db: Db, existing: Existing, input: PatchInput) {
  if (!EDITABLE.includes(existing.status)) return apiError("POST_NOT_EDITABLE", 409);

  const patch: Record<string, unknown> = {};
  if (input.message !== undefined) patch.message = input.message;
  if (input.linkUrl !== undefined) patch.link_url = input.linkUrl || null;
  if (input.note !== undefined) patch.note = input.note || null;

  if (input.pageId !== undefined && input.pageId !== existing.page_id) {
    const { data, error } = await db.pages.select("id").eq("id", input.pageId).eq("is_active", true).maybeSingle();
    if (error) return apiError("DB_ERROR", 500, { detail: error });
    if (!data) return apiError("PAGE_NOT_FOUND", 404);
    patch.page_id = input.pageId;
    // The old Page's "inactive" flag no longer applies to the new Page.
    if (existing.last_error_code === "PAGE_INACTIVE") { patch.last_error_code = null; patch.last_error_message = null; }
  }

  // Images and link/caption rules: a post with images has no link, and may have no caption only if it has images.
  const linkChanged = input.linkUrl !== undefined;
  const effectiveLink = linkChanged ? input.linkUrl || null : existing.link_url;
  let resolved: { ok: true; value: ResolvedMedia } | null = null;
  let kinds: { kind: MediaKind }[] | null = null; // what the post will contain (null = media not looked at)
  try {
    if (input.media !== undefined) {
      const result = await resolveMedia(db, input.media, { linkUrl: effectiveLink, ownPostId: existing.id });
      if (!result.ok) return apiError(result.problem.code, result.problem.status, { message: result.problem.message });
      resolved = result;
      kinds = result.value.rows;
    } else if (linkChanged || input.message !== undefined) {
      const { data: current, error: kindsError } = await db.media.select("kind").eq("post_id", existing.id);
      if (kindsError) throw kindsError;
      kinds = rows<{ kind: MediaKind }>(current);
    }
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
  if (kinds !== null) {
    if (kinds.length > 0 && effectiveLink) return apiError("MEDIA_WITH_LINK", 400);
    if (!(input.message ?? existing.message) && kinds.length === 0) {
      return apiError("INVALID_REQUEST", 400, { message: "Nội dung bài viết không được để trống (trừ khi bài có ảnh).", fields: { message: "Nhập nội dung bài viết (hoặc giữ ít nhất một ảnh/video)." } });
    }
    patch.post_type = derivePostType({ linkUrl: effectiveLink, media: kinds });
  }

  if (input.scheduledAt) {
    if (isPast(input.scheduledAt)) return apiError("SCHEDULE_IN_PAST", 400);
    if (existing.last_error_code === AMBIGUOUS_CODE && !input.force) return apiError("AMBIGUOUS", 409);
    patch.scheduled_at = input.scheduledAt;
    if (existing.status !== "scheduled") { patch.status = "scheduled"; patch.last_error_code = null; patch.last_error_message = null; }
  }
  if (!Object.keys(patch).length) return apiError("INVALID_REQUEST", 400);

  // Changing the images of a QUEUED post: take it out of the queue (scheduled -> draft, guarded like a claim) while its
  // files change, so the scheduler cannot pick it up half way. The update below puts it back.
  let guardStatus = existing.status;
  if (resolved && existing.status === "scheduled") {
    const { data: locked, error: lockError } = await db.posts.update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", existing.id).eq("status", "scheduled").select("id");
    if (lockError) return apiError("DB_ERROR", 500, { detail: lockError });
    if (!locked?.length) return apiError("POST_LOCKED", 409);
    guardStatus = "draft";
    patch.status = "scheduled";
  }
  const putBack = async () => {
    if (guardStatus !== existing.status) await db.posts.update({ status: existing.status }).eq("id", existing.id).eq("status", "draft");
  };

  if (resolved) {
    try { await applyMedia(db, existing.id, resolved.value); }
    catch (e) {
      // Make the post's type match the images it really has before reporting the failure.
      await putBack();
      const { data: now } = await db.media.select("kind").eq("post_id", existing.id);
      await db.posts.update({ post_type: derivePostType({ linkUrl: existing.link_url, media: rows<{ kind: MediaKind }>(now) }) }).eq("id", existing.id);
      return e instanceof MediaConflict ? apiError("MEDIA_IN_USE", 409) : apiError("DB_ERROR", 500, { detail: e });
    }
  }

  // Guard on the status we read: the scheduler may have claimed the post since.
  const { data, error } = await db.posts.update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", existing.id).eq("status", guardStatus).select(COLUMNS).maybeSingle();
  if (error) { await putBack(); return apiError("DB_ERROR", 500, { detail: error }); }
  if (!data) return apiError("POST_LOCKED", 409);
  return NextResponse.json({ post: data });
}

/** Published: Facebook only lets the text change. Facebook first, then our row. */
async function editPublished(db: Db, userId: string, existing: Existing, input: PatchInput) {
  if (existing.facebook_deleted_at) return apiError("POST_ALREADY_DELETED", 409);
  const changesOtherFields =
    (input.linkUrl !== undefined && (input.linkUrl || null) !== existing.link_url) ||
    (input.pageId !== undefined && input.pageId !== existing.page_id) ||
    Boolean(input.scheduledAt) ||
    input.media !== undefined; // Facebook does not let a published post's images change
  if (changesOtherFields) return apiError("EDIT_PUBLISHED_FIELDS", 400);
  if (input.message === undefined && input.note === undefined) return apiError("INVALID_REQUEST", 400);
  if (input.message === "") return apiError("INVALID_REQUEST", 400); // the text of a post on Facebook is never emptied from here
  const messageChanged = input.message !== undefined && input.message !== existing.message;
  const noteChanged = input.note !== undefined && (input.note || null) !== (existing.note ?? null);
  if (!messageChanged && !noteChanged) return apiError("EDIT_NO_CHANGE", 400);

  // Only the private note changed: nothing to tell Facebook.
  if (!messageChanged) {
    const { data, error } = await db.posts.update({ note: input.note || null, updated_at: new Date().toISOString() })
      .eq("id", existing.id).select(COLUMNS).maybeSingle();
    if (error) return apiError("DB_ERROR", 500, { detail: error });
    return NextResponse.json({ post: data });
  }
  const newMessage = input.message as string;

  try {
    await editFacebookMessage(userId, existing, newMessage);
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
    if (failure.gone) {
      await markFacebookGone(userId, existing.id, "detected_missing");
      return failureResponse("FB_POST_GONE", failure.cause);
    }
    await recordEvent(userId, existing.id, "edit_failed", failure.code);
    return failureResponse(failure.code, failure.cause);
  }

  const saved = await writeAfterFacebook(db, existing.id, {
    message: newMessage, edited_at: new Date().toISOString(), ...(noteChanged ? { note: input.note || null } : {})
  });
  await recordEvent(userId, existing.id, "edited", saved ? null : "DB_ERROR");
  if (!saved) return failureResponse("DB_ERROR", "edit applied on Facebook but not saved locally");
  const { data } = await db.posts.select(COLUMNS).eq("id", existing.id).maybeSingle();
  return NextResponse.json({ post: data });
}

/** The user deleted the post on Facebook by hand: confirm it is really gone, then record it. */
async function markDeleted(db: Db, userId: string, existing: Existing) {
  if (existing.status !== "published") return apiError("POST_NOT_EDITABLE", 409);
  if (existing.facebook_deleted_at) return apiError("POST_ALREADY_DELETED", 409);
  try {
    if (!(await isGoneOnFacebook(userId, existing))) return failureResponse("FB_STILL_LIVE");
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
    return failureResponse(failure.code, failure.cause);
  }
  await markFacebookGone(userId, existing.id, "marked_deleted");
  const { data } = await db.posts.select(COLUMNS).eq("id", existing.id).maybeSingle();
  return NextResponse.json({ post: data });
}

/**
 * DELETE /api/posts/[id]
 *  - never published (draft, scheduled, cancelled, failed): the row is removed (nothing is on Facebook);
 *  - published: needs ?scope=facebook, deletes on Facebook (irreversible) and keeps the row as a record;
 *  - already deleted on Facebook: the leftover record is removed.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!uuid.safeParse(id).success) return apiError("POST_NOT_FOUND", 404);
  const db = userDb(user.id);
  const force = request.nextUrl.searchParams.get("force") === "true";
  const onFacebook = request.nextUrl.searchParams.get("scope") === "facebook";

  const { error: readError, post: existing } = await load(db, id);
  if (readError) return apiError("DB_ERROR", 500, { detail: readError });
  if (!existing) return apiError("POST_NOT_FOUND", 404);
  if (existing.status === "publishing") return apiError("POST_LOCKED", 409);

  const removeRow = async (statuses: string[]) => {
    const { data, error } = await db.posts.delete().eq("id", id).in("status", statuses).select("id");
    if (error) return apiError("DB_ERROR", 500, { detail: error });
    if (!data?.length) return apiError("POST_LOCKED", 409);
    return NextResponse.json({ ok: true, deleted: "record" });
  };

  if (existing.status === "published") {
    if (existing.facebook_deleted_at) return removeRow(["published"]);
    if (!onFacebook) return apiError("INVALID_REQUEST", 400, { message: "Bài đã đăng lên Facebook. Hãy xác nhận xóa bài trên Facebook." });
    try {
      await deleteFacebookPost(user.id, existing);
    } catch (e) {
      const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
      await recordEvent(user.id, id, "delete_failed", failure.code);
      return failureResponse(failure.code, failure.cause);
    }
    await markFacebookGone(user.id, id, "deleted_on_facebook");
    return NextResponse.json({ ok: true, deleted: "facebook" });
  }

  if (!EDITABLE.includes(existing.status) && existing.status !== "cancelled") return apiError("POST_NOT_DELETABLE", 409);
  // A failed post with an unknown outcome may be live; deleting its row would lose the only trace of it.
  if (existing.last_error_code === AMBIGUOUS_CODE && !force) return apiError("AMBIGUOUS", 409);
  return removeRow(["draft", "scheduled", "failed", "cancelled"]);
}
