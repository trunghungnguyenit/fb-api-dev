import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { type ErrorCode, logError, messageFor, newRef } from "@/lib/errors";
import { firstMessage, type FieldErrors, zodFieldErrors } from "@/lib/field-errors";

/**
 * JSON error response: Vietnamese message + code + reference. Technical detail is only logged.
 * `fields`: which form fields are wrong and why (field name -> message), so the form can mark them.
 */
export function apiError(code: ErrorCode, status: number, opts: { message?: string; detail?: unknown; fields?: FieldErrors } = {}) {
  const ref = newRef();
  // Every response carries a reference the user may quote, so it must always be findable in the log.
  logError(code, ref, opts.detail, status >= 500 ? "error" : "warn");
  return NextResponse.json({ error: opts.message ?? messageFor(code), code, ref, ...(opts.fields ? { fields: opts.fields } : {}) }, { status });
}

/**
 * 400 for a request body that failed its schema: one message per field (names as the form calls them in `labels`),
 * and the first of them as the main message, so the user is never told only "invalid data".
 */
export function invalidFields(error: ZodError, labels: Record<string, string>, rename: Record<string, string> = {}) {
  const raw = zodFieldErrors(error, labels);
  const fields: FieldErrors = {};
  for (const [key, message] of Object.entries(raw)) fields[rename[key] ?? key] = message;
  return apiError("INVALID_REQUEST", 400, { message: firstMessage(fields) ?? undefined, fields });
}

const FAILURE_STATUS: Partial<Record<ErrorCode, number>> = {
  FB_RATE_LIMITED: 429, FB_UNAVAILABLE: 502, DB_ERROR: 500, TOKEN_DECRYPT_FAILED: 500,
  COMMENTS_SCOPES_MISSING: 403, COMMENTS_PERMISSION_DENIED: 403, COMMENT_GONE: 404, COMMENTS_UNAVAILABLE: 409,
  PAGE_REMOVED_ACTION: 409, PAGE_INACTIVE: 409, PAGE_PERMISSION_LOST: 409, POST_NO_FACEBOOK_ID: 409, FB_POST_GONE: 409, FB_STILL_LIVE: 409
};

/** Response for a failed Facebook operation, with an HTTP status that matches the code. */
export function failureResponse(code: ErrorCode, detail?: unknown) {
  return apiError(code, FAILURE_STATUS[code] ?? 422, { detail });
}
