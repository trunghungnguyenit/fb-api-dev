import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError, invalidFields } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { issueUpload } from "@/lib/media/service";

export const runtime = "nodejs";

// What the browser says it is about to upload. Only a claim: it is checked here, and again on /complete and when publishing.
const bodySchema = z.object({
  kind: z.enum(["image", "video", "reel"]),
  mime: z.string().max(100),
  size: z.number().int().positive(),
  name: z.string().max(300).optional()
});

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidFields(parsed.error, { kind: "Loại tệp", mime: "Định dạng tệp", size: "Dung lượng tệp", name: "Tên tệp" });

  try {
    const result = await issueUpload(user.id, parsed.data);
    if (!result.ok) return apiError(result.problem.code, result.problem.status, { message: result.problem.message });
    return NextResponse.json({ mediaId: result.mediaId, uploadUrl: result.uploadUrl });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
