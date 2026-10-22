import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { runPublishCycle } from "@/lib/publisher";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  if (!isCronAuthorized(request)) return apiError("UNAUTHENTICATED", 401);
  try {
    // stats.hasMore with stopReason "budget": posts are still due, so an external scheduler may call again right away.
    const { results, stats, videos } = await runPublishCycle();
    return NextResponse.json({ processed: results.length, results, stats, videos });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

// POST for external schedulers/curl; GET because Vercel Cron invokes GET with `Authorization: Bearer $CRON_SECRET`.
export const POST = handle;
export const GET = handle;
