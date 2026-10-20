import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

export function isCronAuthorized(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(env.CRON_SECRET);
  return supplied.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
