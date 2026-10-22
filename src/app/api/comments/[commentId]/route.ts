import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { deleteComment, setCommentHidden } from "@/lib/comments";
import { failure, kindSchema, loadTarget, noStore, tooManyActions } from "@/lib/comments-http";
import { COMMENT_ID_PATTERN } from "@/lib/meta/comments";

export const runtime = "nodejs";
export const maxDuration = 30;

const patchSchema = z.object({ kind: kindSchema, postId: z.string().uuid(), hidden: z.boolean() });

/** PATCH /api/comments/[commentId] — hide or show a comment on one of the user's posts. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ commentId: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { commentId } = await context.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, { kind: "Loại bài", postId: "Bài viết", hidden: "Trạng thái ẩn" });
  if (!COMMENT_ID_PATTERN.test(commentId)) return apiError("INVALID_REQUEST", 400, { message: "Mã bình luận không hợp lệ. Hãy tải lại danh sách bình luận." });

  const loaded = await loadTarget(user.id, parsed.data.kind, parsed.data.postId);
  if (loaded.response) return loaded.response;
  const limited = await tooManyActions(user.id);
  if (limited) return limited;
  try {
    await setCommentHidden(user.id, loaded.target, commentId, parsed.data.hidden);
    return noStore({ ok: true, hidden: parsed.data.hidden });
  } catch (e) {
    return failure(e);
  }
}

/** DELETE /api/comments/[commentId]?kind=app|feed&postId=<uuid> — delete a comment (irreversible). */
export async function DELETE(request: NextRequest, context: { params: Promise<{ commentId: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { commentId } = await context.params;
  if (!COMMENT_ID_PATTERN.test(commentId)) return apiError("INVALID_REQUEST", 400);

  const query = request.nextUrl.searchParams;
  const loaded = await loadTarget(user.id, query.get("kind"), query.get("postId") ?? "");
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
