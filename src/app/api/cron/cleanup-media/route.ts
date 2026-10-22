import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { cleanupMedia } from "@/lib/media/cleanup";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

// Hourly job: removes uploads nobody used and the files of posts published (or cancelled) more than 7 days ago.
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request)) return apiError("UNAUTHENTICATED", 401);
  try {
    return NextResponse.json(await cleanupMedia());
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

export const POST = handle;
export const GET = handle;
