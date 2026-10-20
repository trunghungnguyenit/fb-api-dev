import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, userDb } from "@/lib/db";
import { AMBIGUOUS_CODE, processDuePosts } from "@/lib/publisher";
import { apiError, failureResponse } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
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
  message: z.string().trim().min(1).max(63206).optional(),
  linkUrl: z.string().url().refine((v) => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
  pageId: z.string().uuid().optional()
});
type PatchInput = z.infer<typeof patchSchema>;

const EDITABLE = ["draft", "scheduled", "failed"];
const PAST_TOLERANCE_MS = 60_000;
const uuid = z.string().uuid();

const COLUMNS = "id,page_id,message,link_url,status,scheduled_at,published_at,facebook_post_id,last_error_code,edited_at,facebook_deleted_at,created_at,updated_at";

type Existing = {
  id: string; page_id: string; message: string; link_url: string | null; status: string;
  last_error_code: string | null; facebook_post_id: string | null; facebook_deleted_at: string | null;
};
type Db = ReturnType<typeof userDb>;

async function load(db: Db, id: string) {
  const { data, error } = await db.posts
    .select("id,page_id,message,link_url,status,last_error_code,facebook_post_id,facebook_deleted_at").eq("id", id).maybeSingle();
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
  if (!parsed.success) return apiError("INVALID_REQUEST", 400);
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
    if (isPast(input.scheduledAt)) return apiError("SCHEDULE_IN_PAST", 400);
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

  if (input.pageId !== undefined && input.pageId !== existing.page_id) {
    const { data, error } = await db.pages.select("id").eq("id", input.pageId).eq("is_active", true).maybeSingle();
    if (error) return apiError("DB_ERROR", 500, { detail: error });
    if (!data) return apiError("PAGE_NOT_FOUND", 404);
    patch.page_id = input.pageId;
    // The old Page's "inactive" flag no longer applies to the new Page.
    if (existing.last_error_code === "PAGE_INACTIVE") { patch.last_error_code = null; patch.last_error_message = null; }
  }

  if (input.scheduledAt) {
    if (isPast(input.scheduledAt)) return apiError("SCHEDULE_IN_PAST", 400);
    if (existing.last_error_code === AMBIGUOUS_CODE && !input.force) return apiError("AMBIGUOUS", 409);
    patch.scheduled_at = input.scheduledAt;
    if (existing.status !== "scheduled") { patch.status = "scheduled"; patch.last_error_code = null; patch.last_error_message = null; }
  }
  if (!Object.keys(patch).length) return apiError("INVALID_REQUEST", 400);

  // Guard on the status we read: the scheduler may have claimed the post since.
  const { data, error } = await db.posts.update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", existing.id).eq("status", existing.status).select(COLUMNS).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  if (!data) return apiError("POST_LOCKED", 409);
  return NextResponse.json({ post: data });
}

/** Published: Facebook only lets the text change. Facebook first, then our row. */
async function editPublished(db: Db, userId: string, existing: Existing, input: PatchInput) {
  if (existing.facebook_deleted_at) return apiError("POST_ALREADY_DELETED", 409);
  const changesOtherFields =
    (input.linkUrl !== undefined && (input.linkUrl || null) !== existing.link_url) ||
    (input.pageId !== undefined && input.pageId !== existing.page_id) ||
    Boolean(input.scheduledAt);
  if (changesOtherFields) return apiError("EDIT_PUBLISHED_FIELDS", 400);
  if (input.message === undefined) return apiError("INVALID_REQUEST", 400);
  if (input.message === existing.message) return apiError("EDIT_NO_CHANGE", 400);

  try {
    await editFacebookMessage(userId, existing, input.message);
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
    if (failure.gone) {
      await markFacebookGone(userId, existing.id, "detected_missing");
      return failureResponse("FB_POST_GONE", failure.cause);
    }
    await recordEvent(userId, existing.id, "edit_failed", failure.code);
    return failureResponse(failure.code, failure.cause);
  }

  const saved = await writeAfterFacebook(db, existing.id, { message: input.message, edited_at: new Date().toISOString() });
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
