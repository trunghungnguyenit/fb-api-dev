import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, userDb, withPageNames } from "@/lib/db";
import { processDuePosts } from "@/lib/publisher";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";

const createSchema = z.object({
  pageId: z.string().uuid(),
  message: z.string().trim().min(1).max(63206),
  linkUrl: z.string().url().refine(v => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
  scheduledAt: z.string().datetime().optional().or(z.literal("")),
  publishNow: z.boolean().default(false)
});

function validationMessage(error: z.ZodError) {
  switch (String(error.issues[0]?.path[0] ?? "")) {
    case "pageId": return "Vui lòng chọn Fanpage.";
    case "message": return "Nội dung bài viết không được để trống và tối đa 63.206 ký tự.";
    case "linkUrl": return "Liên kết không hợp lệ, phải bắt đầu bằng http:// hoặc https://.";
    case "scheduledAt": return "Thời gian đăng không hợp lệ.";
    default: return undefined;
  }
}

export const maxDuration = 60;

export async function GET() {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const db = userDb(user.id);
  const { data, error } = await db.posts
    .select("id,page_id,message,link_url,status,scheduled_at,published_at,facebook_post_id,last_error_code,created_at")
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
  if (!parsed.success) return apiError("INVALID_REQUEST", 400, { message: validationMessage(parsed.error) });
  const input = parsed.data;
  const db = userDb(user.id);
  if (!input.publishNow && input.scheduledAt && new Date(input.scheduledAt).getTime() < Date.now() - 60_000) {
    return apiError("SCHEDULE_IN_PAST", 400);
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

  const status = input.publishNow ? "scheduled" : input.scheduledAt ? "scheduled" : "draft";
  const scheduledAt = input.publishNow ? new Date(Date.now() - 1000).toISOString() : input.scheduledAt || null;
  const { data, error } = await db.posts.insert({
    page_id: input.pageId, message: input.message,
    link_url: input.linkUrl || null, status, scheduled_at: scheduledAt
  }).select().single();

  if (error || !data) return apiError("DB_ERROR", 500, { detail: error });

  // "Đăng ngay": publish right away instead of waiting for the next scheduler tick.
  if (input.publishNow) {
    try { await processDuePosts({ postId: data.id }); }
    catch (e) { console.error("publishNow failed:", e); }
    const { data: fresh } = await db.posts.select().eq("id", data.id).single();
    return NextResponse.json({ post: fresh ?? data }, { status: 201 });
  }
  return NextResponse.json({ post: data }, { status: 201 });
}
