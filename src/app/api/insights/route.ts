import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { apiError, failureResponse } from "@/lib/api-error";
import { FacebookActionError } from "@/lib/facebook-posts";
import { loadInsights } from "@/lib/insights";
import { resolveRange } from "@/lib/meta/insights";
import { firstMessage } from "@/lib/field-errors";

export const runtime = "nodejs";
export const maxDuration = 30;

const querySchema = z.object({ page: z.string().uuid() });

/**
 * GET /api/insights?page=<fanpage id>&range=7d|28d|90d|custom[&since=YYYY-MM-DD&until=YYYY-MM-DD]
 * The Fanpage's Insights from Facebook, metric by metric (a metric Facebook refuses is reported on its own, with a
 * message that says why). Every failure is a code from the error catalog with a Vietnamese message: Facebook's own
 * wording never reaches the browser.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;

  const query = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({ page: query.get("page") });
  if (!parsed.success) return apiError("PAGE_NOT_FOUND", 404, { fields: { page: "Chọn một Fanpage." } });
  const range = resolveRange({ range: query.get("range"), since: query.get("since"), until: query.get("until") });
  if (!range.ok) return apiError("INVALID_REQUEST", 400, { message: firstMessage(range.errors) ?? undefined, fields: range.errors });

  try {
    const result = await loadInsights(user.id, parsed.data.page, range.range);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const failure = e instanceof FacebookActionError ? e : new FacebookActionError("FB_UNAVAILABLE", false, e);
    if (failure.code === "PAGE_NOT_FOUND") return apiError("PAGE_NOT_FOUND", 404, { detail: failure.cause });
    return failureResponse(failure.code, failure.cause);
  }
}
