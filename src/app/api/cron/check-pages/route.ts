import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { checkAllConnections } from "@/lib/page-sync";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

// Daily job: re-validates every Facebook connection and deactivates Pages that lost access.
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request)) return apiError("UNAUTHENTICATED", 401);
  try {
    return NextResponse.json(await checkAllConnections());
  } catch (e) {
    return apiError("FB_CHECK_FAILED", 500, { detail: e });
  }
}

export const POST = handle;
export const GET = handle;
