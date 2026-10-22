import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { discardMedia } from "@/lib/media/service";

export const runtime = "nodejs";

// The user took an uploaded image out of the form before saving the post. Files that belong to a post are not
// deleted here (editing a post detaches them; the cleanup job removes what nothing uses).
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("MEDIA_NOT_FOUND", 404);

  try {
    const result = await discardMedia(user.id, id);
    if (!result.ok) return apiError(result.problem.code, result.problem.status, { message: result.problem.message });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
