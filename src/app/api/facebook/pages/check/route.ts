import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/csrf";
import { requireUser } from "@/lib/auth";
import { checkUserConnections } from "@/lib/page-sync";
import { logError, newRef } from "@/lib/errors";

export const runtime = "nodejs";

function back(query: string) {
  return NextResponse.redirect(new URL(`/pages?${query}`, env.NEXT_PUBLIC_APP_URL), 303);
}

// Submitted by the "Kiểm tra lại" form on /pages.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return back("error=FORBIDDEN");
  const user = await requireUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL), 303);

  try {
    const r = await checkUserConnections(user.id);
    if (r.errors) {
      const ref = newRef();
      logError("FB_CHECK_FAILED", ref, `${r.errors} connection(s) failed`);
      return back(`error=FB_CHECK_FAILED&ref=${ref}`);
    }
    return back(`checked=1&deactivated=${r.deactivated}`);
  } catch (e) {
    const ref = newRef();
    logError("FB_CHECK_FAILED", ref, e);
    return back(`error=FB_CHECK_FAILED&ref=${ref}`);
  }
}
