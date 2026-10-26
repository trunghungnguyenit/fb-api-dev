import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { tooManyFacebookReads } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { isSameOrigin } from "@/lib/csrf";
import { syncUserFeedsNow } from "@/lib/feed-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST /api/facebook/sync — the "Tải lại từ Facebook" button: reads the posts of all the user's Fanpages now. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return apiError("FORBIDDEN", 403);
  const user = await requireUser();
  if (!user) return apiError("UNAUTHENTICATED", 401);
  const limited = tooManyFacebookReads(user.id);
  if (limited) return limited;
  try {
    return NextResponse.json(await syncUserFeedsNow(user.id));
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}
