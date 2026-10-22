import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, userDb, withPageNames } from "@/lib/db";
import { processDuePosts } from "@/lib/publisher";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { messageFor } from "@/lib/errors";
import { applyMedia, MediaConflict, resolveMedia } from "@/lib/media/service";

const createSchema = z.object({
  pageId: z.string().uuid(),
  // Empty is allowed only for a post that has images (checked below): a photo needs no caption.
  message: z.string().trim().max(63206),
  linkUrl: z.string().url().refine(v => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
  scheduledAt: z.string().datetime().optional().or(z.literal("")),
  publishNow: z.boolean().default(false),
  // Images, in display order: uploaded files (POST /api/media/*) or (clone) files of another of this user's posts.
  media: z.array(z.object({ id: z.string().uuid(), clone: z.boolean().optional() })).max(30).default([])
});

// Names of the fields as the compose form calls them (page, message, link, schedule, media).
const FIELD_LABELS = { pageId: "Fanpage", message: "Nội dung bài viết", linkUrl: "Liên kết", scheduledAt: "Thời gian đăng", media: "Tệp đính kèm" };
const FIELD_NAMES = { pageId: "page", linkUrl: "link", scheduledAt: "schedule" };

export const maxDuration = 60;

export async function GET() {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const db = userDb(user.id);
  const { data, error } = await db.posts
    .select("id,page_id,message,link_url,status,post_type,scheduled_at,published_at,facebook_post_id,last_error_code,created_at")
    .order("created_at", { ascending: false }).limit(200);
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  try {
    return NextResponse.json({ posts: await withPageNames(db, rows<{ page_id: string }>(data)) });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

// Abuse limits per user, enforced from the DB so they hold across serverless instances.
const MAX_OPEN_POSTS = 500;
const MAX_CREATED_PER_MINUTE = 20;

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, FIELD_LABELS, FIELD_NAMES);
  const input = parsed.data;
  if (!input.message && !input.media.length) {
    const message = "Nhập nội dung bài viết (hoặc chọn ảnh/video để đăng không cần chữ).";
    return apiError("INVALID_REQUEST", 400, { message, fields: { message } });
  }
  const db = userDb(user.id);
  if (!input.publishNow && input.scheduledAt && new Date(input.scheduledAt).getTime() < Date.now() - 60_000) {
    return apiError("SCHEDULE_IN_PAST", 400, { fields: { schedule: messageFor("SCHEDULE_IN_PAST") } });
  }

  const [open, recent] = await Promise.all([
    db.posts.select("id", { count: "exact", head: true }).in("status", ["draft", "scheduled"]),
    db.posts.select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 60_000).toISOString())
  ]);
  if (open.error || recent.error) return apiError("DB_ERROR", 500, { detail: open.error ?? recent.error });
  if ((recent.count ?? 0) >= MAX_CREATED_PER_MINUTE) return apiError("RATE_LIMITED", 429);
  if ((open.count ?? 0) >= MAX_OPEN_POSTS) return apiError("QUEUE_FULL", 429);

  const { data: page, error: pageError } = await db.pages.select("id")
    .eq("id", input.pageId).eq("is_active", true).maybeSingle();
  if (pageError) return apiError("DB_ERROR", 500, { detail: pageError });
  if (!page) return apiError("PAGE_NOT_FOUND", 404);

  // Images: every file must exist, be the user's, be fully uploaded and fit the limits. Nothing is changed yet.
  let media;
  try { media = await resolveMedia(db, input.media, { linkUrl: input.linkUrl }); }
  catch (e) { return apiError("DB_ERROR", 500, { detail: e }); }
  if (!media.ok) return apiError(media.problem.code, media.problem.status, { message: media.problem.message });

  const status = input.publishNow ? "scheduled" : input.scheduledAt ? "scheduled" : "draft";
  const scheduledAt = input.publishNow ? new Date(Date.now() - 1000).toISOString() : input.scheduledAt || null;
  const { data, error } = await db.posts.insert({
    page_id: input.pageId, message: input.message,
    link_url: input.linkUrl || null, post_type: media.value.postType,
    // With images the post starts as a plain draft: it must not be queued (and picked up by the scheduler) before
    // its images are attached. It is scheduled right after.
    ...(input.media.length ? { status: "draft", scheduled_at: null } : { status, scheduled_at: scheduledAt })
  }).select().single();

  if (error || !data) return apiError("DB_ERROR", 500, { detail: error });

  if (input.media.length) {
    try { await applyMedia(db, data.id, media.value); }
    catch (e) {
      // A file was taken by someone else in the meantime, or the database failed: do not leave a post without its images.
      await db.posts.delete().eq("id", data.id).eq("status", "draft");
      return e instanceof MediaConflict ? apiError("MEDIA_IN_USE", 409) : apiError("DB_ERROR", 500, { detail: e });
    }
    if (status !== "draft") {
      const { data: queued, error: queueError } = await db.posts.update({ status, scheduled_at: scheduledAt, updated_at: new Date().toISOString() })
        .eq("id", data.id).eq("status", "draft").select().single();
      if (queueError || !queued) return apiError("DB_ERROR", 500, { detail: queueError });
      Object.assign(data, queued);
    }
  }

  // "Đăng ngay": publish right away instead of waiting for the next scheduler tick.
  if (input.publishNow) {
    try { await processDuePosts({ postId: data.id }); }
    catch (e) { console.error("publishNow failed:", e); }
    const { data: fresh } = await db.posts.select().eq("id", data.id).single();
    return NextResponse.json({ post: fresh ?? data }, { status: 201 });
  }
  return NextResponse.json({ post: data }, { status: 201 });
}
