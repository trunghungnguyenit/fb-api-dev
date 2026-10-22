import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { syncDueFeeds } from "@/lib/feed-sync";
import { verifyOlderPosts } from "@/lib/post-liveness";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

// Every minute or so: reads the posts of the Fanpages whose turn has come (each Page every FEED_SYNC_INTERVAL_MIN minutes),
// then asks Facebook directly about a few app posts older than the 7-day window (each about once a day).
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request)) return apiError("UNAUTHENTICATED", 401);
  try {
    const feeds = await syncDueFeeds();
    return NextResponse.json({ ...feeds, older: await verifyOlderPosts() });
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

export const POST = handle;
export const GET = handle;
