import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { deleteRemovedPage } from "@/lib/page-sync";

export const runtime = "nodejs";

/** DELETE /api/facebook/pages/[id] — permanently delete a REMOVED Fanpage that has no posts left. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("PAGE_NOT_FOUND", 404);

  try {
    switch (await deleteRemovedPage(user.id, id)) {
      case "deleted": return NextResponse.json({ ok: true });
      case "not_found": return apiError("PAGE_NOT_FOUND", 404);
      case "not_removed": return apiError("PAGE_NOT_REMOVED", 409);
      case "has_posts": return apiError("PAGE_HAS_POSTS", 409);
    }
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
