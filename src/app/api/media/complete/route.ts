import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { confirmUpload } from "@/lib/media/service";

export const runtime = "nodejs";

const bodySchema = z.object({ mediaId: z.string().uuid() });

// Called by the browser after it uploaded the file: the server looks at what is REALLY in storage before the
// file can be used in a post.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_REQUEST", 400);

  try {
    const result = await confirmUpload(user.id, parsed.data.mediaId);
    if (!result.ok) return apiError(result.problem.code, result.problem.status, { message: result.problem.message });
    return NextResponse.json({ media: { id: result.media.id, size: result.media.size_bytes, state: result.media.state } });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
