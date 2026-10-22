import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { restoreRemovedPage } from "@/lib/page-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST /api/facebook/pages/[id]/restore — "Kết nối lại" a removed Fanpage, if Facebook still lets this user manage it. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("PAGE_NOT_FOUND", 404);

  try {
    switch (await restoreRemovedPage(user.id, id)) {
      case "restored": return NextResponse.json({ ok: true });
      case "not_found": return apiError("PAGE_NOT_FOUND", 404);
      case "not_removed": return apiError("PAGE_NOT_REMOVED", 409);
      case "unavailable": return apiError("PAGE_RESTORE_UNAVAILABLE", 409);
    }
  } catch (e) {
    // Facebook or the network failed to answer at all: not the same as "no longer allowed".
    return apiError("FB_UNAVAILABLE", 502, { detail: e });
  }
}
