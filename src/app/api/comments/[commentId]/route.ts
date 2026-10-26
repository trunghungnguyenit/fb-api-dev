import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { deleteComment, editComment, setCommentHidden, setCommentLiked } from "@/lib/comments";
import { failure, kindSchema, loadTarget, noStore, tooManyActions } from "@/lib/comments-http";
import { COMMENT_ID_PATTERN, COMMENT_MAX_LENGTH } from "@/lib/meta/comments";
import { VISITOR_POST_ID_PATTERN } from "@/lib/meta/guest";

export const runtime = "nodejs";
export const maxDuration = 30;

// One change per request: hide / show it, like / unlike it as the Fanpage, or change its text (the Fanpage's own comments only).
const patchSchema = z.object({
  kind: kindSchema, postId: z.string().uuid(), facebookPostId: z.string().regex(VISITOR_POST_ID_PATTERN).optional(), hidden: z.boolean().optional(), liked: z.boolean().optional(),
  message: z.string().trim().min(1).max(COMMENT_MAX_LENGTH).optional()
});

/** PATCH /api/comments/[commentId] — hide, like or edit a comment on one of the user's posts. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ commentId: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { commentId } = await context.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, { kind: "Loại bài", postId: "Bài viết", hidden: "Trạng thái ẩn", liked: "Trạng thái thích", message: "Nội dung bình luận" });
  const { hidden, liked, message } = parsed.data;
  if ([hidden, liked, message].filter((v) => v !== undefined).length !== 1) return apiError("INVALID_REQUEST", 400);
  if (!COMMENT_ID_PATTERN.test(commentId)) return apiError("INVALID_REQUEST", 400, { message: "Mã bình luận không hợp lệ. Hãy tải lại danh sách bình luận." });

  const loaded = await loadTarget(user.id, parsed.data.kind, parsed.data.postId, parsed.data.facebookPostId);
  if (loaded.response) return loaded.response;
  const limited = await tooManyActions(user.id);
  if (limited) return limited;
  try {
    if (hidden !== undefined) { await setCommentHidden(user.id, loaded.target, commentId, hidden); return noStore({ ok: true, hidden }); }
    if (liked !== undefined) { await setCommentLiked(user.id, loaded.target, commentId, liked); return noStore({ ok: true, liked }); }
    await editComment(user.id, loaded.target, commentId, message ?? "");
    return noStore({ ok: true });
  } catch (e) {
    return failure(e);
  }
}

/** DELETE /api/comments/[commentId]?kind=app|feed|visitor&postId=<uuid>[&fbPost=<visitor post id>] — delete a comment (irreversible). */
export async function DELETE(request: NextRequest, context: { params: Promise<{ commentId: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { commentId } = await context.params;
  if (!COMMENT_ID_PATTERN.test(commentId)) return apiError("INVALID_REQUEST", 400);

  const query = request.nextUrl.searchParams;
  const loaded = await loadTarget(user.id, query.get("kind"), query.get("postId") ?? "", query.get("fbPost"));
  if (loaded.response) return loaded.response;
  const limited = await tooManyActions(user.id);
  if (limited) return limited;
  try {
    await deleteComment(user.id, loaded.target, commentId);
    return noStore({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
