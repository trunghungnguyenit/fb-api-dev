import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { listComments, replyToComment } from "@/lib/comments";
import { adoptLiveCount } from "@/lib/new-comments";
import { failure, kindSchema, loadTarget, noStore, tooManyActions } from "@/lib/comments-http";
import { COMMENT_ID_PATTERN, COMMENT_MAX_LENGTH } from "@/lib/meta/comments";
import { VISITOR_POST_ID_PATTERN } from "@/lib/meta/guest";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/posts/[id]/comments?kind=app|feed|visitor[&fbPost=<visitor post id>][&after=<cursor>][&parent=<comment id>]
 * One page of the post's comments from Facebook (or the replies of one comment). Comment text is never stored.
 * For kind=visitor, [id] is the Fanpage row and fbPost the visitor post on its wall.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;
  const { id } = await context.params;
  const query = request.nextUrl.searchParams;
  const loaded = await loadTarget(user.id, query.get("kind"), id, query.get("fbPost"));
  if (loaded.response) return loaded.response;

  const after = query.get("after") ?? undefined;
  const parent = query.get("parent") ?? undefined;
  if ((after && !/^[\w=-]{1,500}$/.test(after)) || (parent && !COMMENT_ID_PATTERN.test(parent))) return apiError("INVALID_REQUEST", 400);
  try {
    const page = await listComments(user.id, loaded.target, { after, parentId: parent });
    // The first page of a post's comments was just read live: its total is now what the user has seen (see new-comments.ts).
    if (!after && !parent && page.total !== null && loaded.target.kind !== "visitor") {
      await adoptLiveCount(user.id, loaded.target.kind === "feed" ? { feedId: loaded.target.id } : { postId: loaded.target.id }, page.total);
    }
    return noStore(page);
  } catch (e) {
    return failure(e);
  }
}

const replySchema = z.object({
  kind: kindSchema,
  facebookPostId: z.string().regex(VISITOR_POST_ID_PATTERN).optional(),
  message: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
  // Reply to this comment; leave out to comment on the post itself.
  replyTo: z.string().regex(COMMENT_ID_PATTERN).optional()
});

/** POST /api/posts/[id]/comments — reply to a comment (or comment on the post) as the Fanpage. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, { message: "Nội dung trả lời", kind: "Loại bài", replyTo: "Bình luận được trả lời" });

  const loaded = await loadTarget(user.id, parsed.data.kind, id, parsed.data.facebookPostId);
  if (loaded.response) return loaded.response;
  const limited = await tooManyActions(user.id);
  if (limited) return limited;
  try {
    return noStore(await replyToComment(user.id, loaded.target, parsed.data.message, parsed.data.replyTo), 201);
  } catch (e) {
    return failure(e);
  }
}
