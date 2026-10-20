import { NextResponse } from "next/server";
import { type ErrorCode, logError, messageFor, newRef } from "@/lib/errors";

/** JSON error response: Vietnamese message + code + reference. Technical detail is only logged. */
export function apiError(code: ErrorCode, status: number, opts: { message?: string; detail?: unknown } = {}) {
  const ref = newRef();
  // Every response carries a reference the user may quote, so it must always be findable in the log.
  logError(code, ref, opts.detail, status >= 500 ? "error" : "warn");
  return NextResponse.json({ error: opts.message ?? messageFor(code), code, ref }, { status });
}

const FAILURE_STATUS: Partial<Record<ErrorCode, number>> = {
  FB_RATE_LIMITED: 429, FB_UNAVAILABLE: 502, DB_ERROR: 500, TOKEN_DECRYPT_FAILED: 500,
  PAGE_INACTIVE: 409, PAGE_PERMISSION_LOST: 409, POST_NO_FACEBOOK_ID: 409, FB_POST_GONE: 409, FB_STILL_LIVE: 409
};

/** Response for a failed Facebook operation, with an HTTP status that matches the code. */
export function failureResponse(code: ErrorCode, detail?: unknown) {
  return apiError(code, FAILURE_STATUS[code] ?? 422, { detail });
}
