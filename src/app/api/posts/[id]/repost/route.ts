import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { one, rows, userDb } from "@/lib/db";
import { apiError, failureResponse } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { AMBIGUOUS_CODE } from "@/lib/publisher";
import { logError, messageFor, newRef } from "@/lib/errors";
import {
  deleteFacebookPost, FacebookActionError, markFacebookGone, recordEvent
} from "@/lib/facebook-posts";
import {
  isLiveOnFacebook, MAX_REPOST_PAGES, pagesOverLimit, REPOST_LIMIT_PER_DAY, repostModes, repostRoot, repostSchedule
} from "@/lib/repost";
import { fetchPosts, insertClones, publishInline, recentRepostCounts } from "@/lib/repost-service";

export const runtime = "nodejs";
export const maxDuration = 60;

// Abuse limits per user, shared with POST /api/posts (enforced from the DB so they hold across instances).
const MAX_OPEN_POSTS = 500;
const MAX_CREATED_PER_MINUTE = 20;
const PAST_TOLERANCE_MS = 60_000;

const bodySchema = z.object({
  mode: z.enum(["same_row", "clone", "replace"]),
  message: z.string().trim().min(1).max(63206),
  linkUrl: z.string().url().refine((v) => /^https?:\/\//i.test(v)).optional().or(z.literal("")),
  pageIds: z.array(z.string().uuid()).min(1).max(MAX_REPOST_PAGES),
  // "now" | "draft" | ISO date-time
  when: z.union([z.literal("now"), z.literal("draft"), z.string().datetime()]),
  confirmLive: z.boolean().optional(),   // the user accepted the "original is still on Facebook" warning
  force: z.boolean().optional(),         // the original's outcome is unknown (AMBIGUOUS) and the user accepted that
  deleteOldFirst: z.boolean().optional() // replace: delete the old post BEFORE posting (after Facebook said "duplicate")
});

type Source = {
  id: string; page_id: string; message: string; link_url: string | null; status: string;
  facebook_post_id: string | null; facebook_deleted_at: string | null; last_error_code: string | null; reposted_from: string | null;
};
const SOURCE_COLUMNS = "id,page_id,message,link_url,status,facebook_post_id,facebook_deleted_at,last_error_code,reposted_from";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("POST_NOT_FOUND", 404);
  const raw = await request.json().catch(() => null);
  if (Array.isArray(raw?.pageIds) && raw.pageIds.length > MAX_REPOST_PAGES) return apiError("TOO_MANY_PAGES", 400);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return apiError("INVALID_REQUEST", 400);
  const input = parsed.data;
  const db = userDb(user.id);

  const { data, error } = await db.posts.select(SOURCE_COLUMNS).eq("id", id).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  const source = one<Source>(data);
  if (!source) return apiError("POST_NOT_FOUND", 404);

  // --- rules that depend on the source post ----------------------------------------------------------
  if (!repostModes(source).includes(input.mode)) return apiError("REPOST_NOT_ALLOWED", 409);
  // An unknown outcome means the original may be live: only an explicit `force` may continue.
  if (source.last_error_code === AMBIGUOUS_CODE && !input.force) return apiError("AMBIGUOUS", 409);
  const live = isLiveOnFacebook(source);
  if (live && input.mode === "clone" && !input.confirmLive) return apiError("CONFIRM_DUPLICATE_LIVE", 409);

  let pageIds = [...new Set(input.pageIds)];
  if (input.mode === "replace") {
    if (input.when !== "now") return apiError("REPLACE_NOW_ONLY", 400);
    pageIds = [source.page_id]; // the old post is on this Page, so the new one must be too
  }
  if (input.mode === "same_row" && pageIds.length !== 1) return apiError("INVALID_REQUEST", 400);
  if (input.when !== "now" && input.when !== "draft" && new Date(input.when).getTime() < Date.now() - PAST_TOLERANCE_MS) {
    return apiError("SCHEDULE_IN_PAST", 400);
  }

  // --- target Fanpages must be this user's and active ------------------------------------------------
  const { data: pageData, error: pageError } = await db.pages.select("id,page_name").in("id", pageIds).eq("is_active", true);
  if (pageError) return apiError("DB_ERROR", 500, { detail: pageError });
  const pages = rows<{ id: string; page_name: string }>(pageData);
  if (pages.length !== pageIds.length) return apiError("PAGE_NOT_FOUND", 404);

  // --- anti-spam limits -----------------------------------------------------------------------------
  const root = repostRoot(source);
  try {
    const counts = (await recentRepostCounts(db, [{ id: source.id, root, page_id: source.page_id }])).get(root) ?? new Map<string, number>();
    const over = pagesOverLimit(counts, pageIds);
    if (over.length) {
      const names = pages.filter((p) => over.includes(p.id)).map((p) => `“${p.page_name}”`).join(", ");
      return apiError("REPOST_LIMIT", 429, { message: `Bài này đã được đăng lại ${REPOST_LIMIT_PER_DAY} lần lên ${names} trong 24 giờ. Vui lòng thử lại sau.` });
    }
    if (input.mode !== "same_row") {
      const [open, recent] = await Promise.all([
        db.posts.select("id", { count: "exact", head: true }).in("status", ["draft", "scheduled"]),
        db.posts.select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 60_000).toISOString())
      ]);
      if (open.error || recent.error) throw open.error ?? recent.error;
      if ((recent.count ?? 0) + pageIds.length > MAX_CREATED_PER_MINUTE) return apiError("RATE_LIMITED", 429);
      if ((open.count ?? 0) + pageIds.length > MAX_OPEN_POSTS) return apiError("QUEUE_FULL", 429);
    }
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }

  const content = { message: input.message, linkUrl: input.linkUrl || null };
  try {
    if (input.mode === "same_row") return await sameRow(db, user.id, source, pageIds[0], content, input.when);
    if (input.mode === "clone") return await cloneToPages(db, root, pageIds, content, input.when);
    return await replace(db, user.id, source, root, content, Boolean(input.deleteOldFirst));
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

type Db = ReturnType<typeof userDb>;
type Content = { message: string; linkUrl: string | null };

/** Re-queue this very row. Only for a post that is not on Facebook any more (deleted, failed or cancelled). */
async function sameRow(db: Db, userId: string, source: Source, pageId: string, content: Content, when: string) {
  const deleted = source.status === "published";
  let update = db.posts.update({
    message: content.message, link_url: content.linkUrl, page_id: pageId, ...repostSchedule(when),
    published_at: null, facebook_post_id: null, facebook_deleted_at: null, edited_at: null,
    last_error_code: null, last_error_message: null, locked_at: null, sent_at: null, updated_at: new Date().toISOString()
  }).eq("id", source.id).eq("status", source.status);
  // A published row may only be reused once it is known to be gone from Facebook.
  if (deleted) update = update.not("facebook_deleted_at", "is", null);
  const { data, error } = await update.select("id");
  if (error) throw error;
  if (!data?.length) return apiError("POST_LOCKED", 409);

  await recordEvent(userId, source.id, "republished");
  if (when === "now") await publishInline([source.id]);
  return NextResponse.json({ posts: await fetchPosts(db, [source.id]), warnings: [] });
}

/** New row(s), one per Fanpage; the original is untouched. */
async function cloneToPages(db: Db, root: string, pageIds: string[], content: Content, when: string) {
  const created = await insertClones(db, pageIds.map((pageId) => ({ root, pageId, ...content })), when);
  const ids = created.map((p) => p.id);
  if (when === "now") await publishInline(ids);
  return NextResponse.json({ posts: await fetchPosts(db, ids), warnings: [] });
}

/**
 * Replace a live post: publish the new one first and delete the old one only after that succeeded, so the
 * Page never ends up with neither. If Facebook refuses the new post as a duplicate, ask the user to delete
 * the old one first (`deleteOldFirst`).
 */
async function replace(db: Db, userId: string, source: Source, root: string, content: Content, deleteOldFirst: boolean) {
  if (deleteOldFirst) {
    try { await deleteFacebookPost(userId, source); }
    catch (e) {
      const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
      await recordEvent(userId, source.id, "delete_failed", failure.code);
      return failureResponse(failure.code, failure.cause);
    }
    await markFacebookGone(userId, source.id, "deleted_on_facebook");
  }

  const [created] = await insertClones(db, [{ root, pageId: source.page_id, ...content }], "now");
  await publishInline([created.id]);
  const [fresh] = await fetchPosts(db, [created.id]);

  if (fresh?.status === "published") {
    const warnings: { code: string; message: string }[] = [];
    if (!deleteOldFirst) {
      try {
        await deleteFacebookPost(userId, source);
        await markFacebookGone(userId, source.id, "deleted_on_facebook");
      } catch (e) {
        const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
        await recordEvent(userId, source.id, "delete_failed", failure.code);
        warnings.push({ code: "REPLACE_OLD_NOT_DELETED", message: messageFor("REPLACE_OLD_NOT_DELETED") });
      }
    }
    return NextResponse.json({ posts: [fresh], warnings });
  }

  // The new post did not go out. Facebook said "duplicate" before creating anything, so the throw-away
  // row can be removed and the user asked to delete the old post first.
  if (!deleteOldFirst && fresh?.last_error_code === "FB_DUPLICATE") {
    await db.posts.delete().eq("id", created.id).eq("status", "failed");
    return apiError("REPLACE_NEEDS_DELETE_FIRST", 409);
  }

  // Any other failure: the old post is untouched; report it and keep the failed row so it can be retried.
  const code = fresh?.last_error_code ?? "PUBLISH_FAILED";
  const ref = newRef();
  logError("PUBLISH_FAILED", ref, `replace: new post ended as ${fresh?.status} (${code})`, "warn");
  return NextResponse.json({ error: messageFor(code, "PUBLISH_FAILED"), code, ref, posts: fresh ? [fresh] : [] }, { status: 422 });
}
