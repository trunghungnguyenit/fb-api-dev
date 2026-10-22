import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { removePage } from "@/lib/page-sync";

export const runtime = "nodejs";

/**
 * POST /api/facebook/pages/[id]/remove — disconnect a Fanpage: wipe its token, keep its history, cancel its
 * unpublished posts. Idempotent, so a retry finishes a removal that stopped half-way.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("PAGE_NOT_FOUND", 404);

  try {
    const result = await removePage(user.id, id);
    if (!result.ok) return result.reason === "not_found" ? apiError("PAGE_NOT_FOUND", 404) : apiError("PAGE_HAS_PUBLISHING", 409);
    return NextResponse.json({ ok: true, cancelled: result.cancelled });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
