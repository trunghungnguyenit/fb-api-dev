import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/csrf";
import { requireUser } from "@/lib/auth";
import { syncPageNow } from "@/lib/feed-sync";
import { logError, newRef } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

function back(query: string) {
  return NextResponse.redirect(new URL(`/pages?${query}`, env.NEXT_PUBLIC_APP_URL), 303);
}

// Submitted by the "Đồng bộ bài ngay" button on /pages: reads this Fanpage's posts from Facebook now.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return back("error=FORBIDDEN");
  const user = await requireUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL), 303);
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return back("error=PAGE_NOT_FOUND");

  try {
    const result = await syncPageNow(user.id, id);
    if (result.status === "not_found") return back("error=PAGE_NOT_FOUND");
    if (result.status === "inactive") return back("error=PAGE_INACTIVE");
    if (result.status === "too_soon") return back("feedsynced=recent");
    if (result.status === "synced") return back(`feedsynced=${result.seen}`);
    if (result.status === "deferred") return back("error=FB_RATE_LIMITED");
    return back(`error=${result.error}`);
  } catch (e) {
    const ref = newRef();
    logError("DB_ERROR", ref, e);
    return back(`error=DB_ERROR&ref=${ref}`);
  }
}
