import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/csrf";
import { requireUser } from "@/lib/auth";
import { markNotificationsRead } from "@/lib/notifications";
import { logError, newRef } from "@/lib/errors";

export const runtime = "nodejs";

const ids = z.array(z.string().uuid()).max(200);

function back(query = "") {
  return NextResponse.redirect(new URL(`/notifications${query}`, env.NEXT_PUBLIC_APP_URL), 303);
}

// Submitted by the forms on /notifications: one or more `id` fields, or none to mark everything as read.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return back("?error=FORBIDDEN");
  const user = await requireUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL), 303);

  const form = await request.formData().catch(() => null);
  const selected = form?.getAll("id").map(String) ?? [];
  const parsed = ids.safeParse(selected);
  if (!parsed.success) return back("?error=INVALID_REQUEST");

  try {
    await markNotificationsRead(user.id, selected.length ? parsed.data : undefined);
    return back();
  } catch (e) {
    const ref = newRef();
    logError("DB_ERROR", ref, e);
    return back(`?error=DB_ERROR&ref=${ref}`);
  }
}
