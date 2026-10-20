import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, userDb } from "@/lib/db";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { AMBIGUOUS_CODE } from "@/lib/publisher";
import { type ErrorCode, messageFor } from "@/lib/errors";
import { isLiveOnFacebook, MAX_BULK_REPOST, pagesOverLimit, repostModes, repostRoot } from "@/lib/repost";
import { fetchPosts, insertClones, publishInline, recentRepostCounts } from "@/lib/repost-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IDS = 50;
const MAX_OPEN_POSTS = 500;
const MAX_CREATED_PER_MINUTE = 20;
const schema = z.object({
  action: z.enum(["cancel", "delete", "repost"]),
  ids: z.array(z.string().uuid()).min(1),
  // repost only: "draft" creates reviewable copies, "now" publishes them straight away
  when: z.enum(["draft", "now"]).optional()
});

type Row = {
  id: string; status: string; last_error_code: string | null; facebook_deleted_at: string | null;
  page_id: string; message: string; link_url: string | null; reposted_from: string | null; facebook_post_id: string | null;
};
const CANCELLABLE = ["draft", "scheduled", "failed"];
const NEVER_PUBLISHED = ["draft", "scheduled", "failed", "cancelled"];

/**
 * POST /api/posts/bulk — cancel, delete or re-post many posts at once. Deliberately conservative: it never
 * touches a post that is live on Facebook (deleting or duplicating one stays a per-post, confirmed action)
 * and skips anything whose outcome is unclear, reporting why for each skipped post.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_REQUEST", 400);
  const { action } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];
  if (ids.length > (action === "repost" ? MAX_BULK_REPOST : MAX_IDS)) return apiError("BULK_LIMIT", 400);
  const db = userDb(user.id);

  const { data, error } = await db.posts
    .select("id,status,last_error_code,facebook_deleted_at,page_id,message,link_url,reposted_from,facebook_post_id").in("id", ids);
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  const byId = new Map(rows<Row>(data).map((r) => [r.id, r]));

  const skipped = new Map<string, ErrorCode>();
  const eligible: Row[] = [];
  for (const id of ids) {
    const post = byId.get(id);
    if (!post) { skipped.set(id, "POST_NOT_FOUND"); continue; }
    if (post.status === "publishing") { skipped.set(id, "POST_LOCKED"); continue; }

    if (action === "cancel") {
      if (CANCELLABLE.includes(post.status)) eligible.push(post); else skipped.set(id, "POST_STATE_INVALID");
    } else if (action === "repost") {
      if (isLiveOnFacebook(post)) skipped.set(id, "REPOST_LIVE_BULK");
      else if (post.last_error_code === AMBIGUOUS_CODE) skipped.set(id, "AMBIGUOUS");
      else if (repostModes(post).includes("clone")) eligible.push(post);
      else skipped.set(id, "REPOST_NOT_ALLOWED");
    } else if (post.status === "published") {
      if (post.facebook_deleted_at) eligible.push(post); else skipped.set(id, "POST_NOT_DELETABLE");
    } else if (post.last_error_code === AMBIGUOUS_CODE) skipped.set(id, "AMBIGUOUS");
    else if (NEVER_PUBLISHED.includes(post.status)) eligible.push(post);
    else skipped.set(id, "POST_NOT_DELETABLE");
  }

  const respond = (done: number, extra: Record<string, unknown> = {}) => NextResponse.json({
    done, ...extra,
    skipped: [...skipped].map(([id, code]) => ({ id, code, message: messageFor(code) }))
  });

  if (action === "repost") {
    try {
      const result = await repostMany(db, eligible, parsed.data.when ?? "draft", skipped);
      return respond(result.done, { posts: result.posts });
    } catch (e) {
      return apiError("DB_ERROR", 500, { detail: e });
    }
  }

  const done = new Set<string>();
  const collect = (result: { data: unknown; error: unknown }) => {
    if (result.error) throw result.error;
    for (const r of rows<{ id: string }>(result.data)) done.add(r.id);
  };
  try {
    const eligibleIds = eligible.map((p) => p.id);
    if (eligibleIds.length && action === "cancel") {
      collect(await db.posts.update({ status: "cancelled", scheduled_at: null, updated_at: new Date().toISOString() })
        .in("id", eligibleIds).in("status", CANCELLABLE).select("id"));
    } else if (eligibleIds.length) {
      // Two queries so a post that was retried and published in the meantime can never match.
      const unpublished = eligible.filter((p) => p.status !== "published").map((p) => p.id);
      const leftovers = eligible.filter((p) => p.status === "published").map((p) => p.id);
      if (unpublished.length) collect(await db.posts.delete().in("id", unpublished).in("status", NEVER_PUBLISHED).select("id"));
      if (leftovers.length) collect(await db.posts.delete().in("id", leftovers).eq("status", "published").not("facebook_deleted_at", "is", null).select("id"));
    }
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
  for (const p of eligible) if (!done.has(p.id)) skipped.set(p.id, "POST_LOCKED");
  return respond(done.size);
}

/** Copies each eligible post (same Fanpage, same content) as a new row, within the anti-spam limits. */
async function repostMany(db: ReturnType<typeof userDb>, eligible: Row[], when: "draft" | "now", skipped: Map<string, ErrorCode>) {
  if (!eligible.length) return { done: 0, posts: [] };

  // Only active Fanpages can receive a post.
  const { data: pageData, error: pageError } = await db.pages.select("id")
    .in("id", [...new Set(eligible.map((p) => p.page_id))]).eq("is_active", true);
  if (pageError) throw pageError;
  const activePages = new Set(rows<{ id: string }>(pageData).map((p) => p.id));

  const [open, recent] = await Promise.all([
    db.posts.select("id", { count: "exact", head: true }).in("status", ["draft", "scheduled"]),
    db.posts.select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 60_000).toISOString())
  ]);
  if (open.error || recent.error) throw open.error ?? recent.error;
  let rateRoom = MAX_CREATED_PER_MINUTE - (recent.count ?? 0);
  let openRoom = MAX_OPEN_POSTS - (open.count ?? 0);

  const counts = await recentRepostCounts(db, eligible.map((p) => ({ id: p.id, root: repostRoot(p), page_id: p.page_id })));
  const accepted: Row[] = [];
  for (const post of eligible) {
    const root = repostRoot(post);
    const perPage = counts.get(root) ?? new Map<string, number>();
    if (!activePages.has(post.page_id)) { skipped.set(post.id, "PAGE_INACTIVE"); continue; }
    if (pagesOverLimit(perPage, [post.page_id]).length) { skipped.set(post.id, "REPOST_LIMIT"); continue; }
    if (rateRoom <= 0) { skipped.set(post.id, "RATE_LIMITED"); continue; }
    if (openRoom <= 0) { skipped.set(post.id, "QUEUE_FULL"); continue; }
    perPage.set(post.page_id, (perPage.get(post.page_id) ?? 0) + 1); // counts toward the limit for later posts in this batch
    counts.set(root, perPage);
    rateRoom--; openRoom--;
    accepted.push(post);
  }
  if (!accepted.length) return { done: 0, posts: [] };

  const created = await insertClones(db, accepted.map((p) => ({
    root: repostRoot(p), pageId: p.page_id, message: p.message, linkUrl: p.link_url
  })), when);
  const createdIds = created.map((p) => p.id);
  if (when === "now") await publishInline(createdIds);
  return { done: created.length, posts: await fetchPosts(db, createdIds) };
}
