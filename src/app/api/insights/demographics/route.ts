import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { apiError, failureResponse } from "@/lib/api-error";
import { loadDemographics } from "@/lib/demographics";
import { FacebookActionError } from "@/lib/facebook-posts";

export const runtime = "nodejs";
export const maxDuration = 30;

const querySchema = z.object({ page: z.string().uuid() });

/**
 * GET /api/insights/demographics?page=<fanpage id>
 * Who follows the Fanpage (country, city, gender and age), block by block: a breakdown Facebook refuses is reported on its
 * own, with a message that says why. Every failure is a code from the error catalog with a Vietnamese message: Facebook's
 * own wording never reaches the browser.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;
  const parsed = querySchema.safeParse({ page: request.nextUrl.searchParams.get("page") });
  if (!parsed.success) return apiError("PAGE_NOT_FOUND", 404, { fields: { page: "Chọn một Fanpage." } });

  try {
    const result = await loadDemographics(user.id, parsed.data.page);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("FB_UNAVAILABLE", false, e);
    if (failure.code === "PAGE_NOT_FOUND") return apiError("PAGE_NOT_FOUND", 404, { detail: failure.cause });
    return failureResponse(failure.code, failure.cause);
  }
}
