import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { apiError, failureResponse } from "@/lib/api-error";
import { FacebookActionError } from "@/lib/facebook-posts";
import { loadPostReactions } from "@/lib/post-reactions";

export const runtime = "nodejs";
export const maxDuration = 30;

const querySchema = z.object({ kind: z.enum(["app", "feed"]), id: z.string().uuid() });

/**
 * GET /api/posts/[id]/reactions?kind=app|feed
 * Reactions of one post by kind, from Facebook (a kind Facebook will not answer is left empty, the others show). `id` is the app's post (kind app) or a post read from the Fanpage (kind feed). Every failure is a code
 * from the error catalog with a Vietnamese message: Facebook's own wording never reaches the browser.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;
  const { id } = await context.params;
  const parsed = querySchema.safeParse({ kind: request.nextUrl.searchParams.get("kind"), id });
  if (!parsed.success) return apiError("POST_NOT_FOUND", 404);

  try {
    const result = await loadPostReactions(user.id, parsed.data);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("FB_UNAVAILABLE", false, e);
    if (failure.code === "POST_NOT_FOUND" || failure.code === "PAGE_NOT_FOUND") return apiError(failure.code, 404, { detail: failure.cause });
    return failureResponse(failure.code, failure.cause);
  }
}
