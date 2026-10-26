import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

// A ceiling on how fast one user (or address) may ask for things that cost a call to Facebook: it stops a script from draining the
// app's allowance with Meta or reading everything in bulk. Kept in this server's memory: with several instances each has its own
// count, so the real ceiling is a multiple of the number, which is still the point (a bound, not an exact meter). The write
// actions have their own, database-backed, limits.

const windows = new Map<string, number[]>();
const MAX_KEYS = 5000;

export type Verdict = { ok: boolean; /** Seconds until one more is allowed (when not ok). */ retryAfter: number };

/** Counts one request for `key` and says whether it is within `max` per `windowMs`. */
export function rateLimit(key: string, max: number, windowMs = 60_000, now = Date.now()): Verdict {
  const recent = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  recent.push(now);
  windows.delete(key); // re-inserted last, so the oldest key is always the first one
  windows.set(key, recent);
  // A hard bound: more keys than this cannot be real users, so the one that has been quiet longest goes (no scan of the map).
  if (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value as string);
  return { ok: true, retryAfter: 0 };
}

export function resetRateLimits() { windows.clear(); }

/** Reads that go on to Facebook: Insights, reactions, comments, demographics... */
export const FACEBOOK_READS_PER_MINUTE = 120;

/** The answer to give when `userId` has asked for too many Facebook reads this minute, or null when it may go on. */
export function tooManyFacebookReads(userId: string): NextResponse | null {
  const verdict = rateLimit(`fb-read:${userId}`, FACEBOOK_READS_PER_MINUTE);
  if (verdict.ok) return null;
  const response = apiError("RATE_LIMITED", 429);
  response.headers.set("Retry-After", String(verdict.retryAfter));
  return response;
}
