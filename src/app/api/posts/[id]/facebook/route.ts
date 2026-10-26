import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { one, userDb } from "@/lib/db";
import { apiError, failureResponse } from "@/lib/api-error";
import {
  clearFacebookGone, FacebookActionError, markFacebookGone, readFacebookPost
} from "@/lib/facebook-posts";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/posts/[id]/facebook — live numbers from Facebook, and a sync of the post's state:
 * a post found missing is marked deleted, a post marked deleted that is live again is restored.
 * Called by the detail page after it has rendered, so a slow Graph call never blocks the page.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("POST_NOT_FOUND", 404);

  const { data, error } = await userDb(user.id).posts
    .select("id,page_id,status,post_type,facebook_post_id,facebook_deleted_at").eq("id", id).maybeSingle();
  if (error) return apiError("DB_ERROR", 500, { detail: error });
  const post = one<{ id: string; page_id: string; status: string; post_type: string; facebook_post_id: string | null; facebook_deleted_at: string | null }>(data);
  if (!post) return apiError("POST_NOT_FOUND", 404);
  if (post.status !== "published" || !post.facebook_post_id) return apiError("POST_NO_FACEBOOK_ID", 409);

  try {
    const stats = await readFacebookPost(user.id, post);
    if (post.facebook_deleted_at) await clearFacebookGone(user.id, id);
    return NextResponse.json({ state: "live", ...stats });
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
    if (failure.gone) {
      if (!post.facebook_deleted_at) await markFacebookGone(user.id, id, "detected_missing");
      return NextResponse.json({ state: "deleted" });
    }
    return failureResponse(failure.code, failure.cause);
  }
}
