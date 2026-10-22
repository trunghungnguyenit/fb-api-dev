import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, failureResponse } from "@/lib/api-error";
import { commentActionsRecently, MAX_COMMENT_ACTIONS_PER_MINUTE, resolveCommentTarget } from "@/lib/comments";
import { FacebookActionError } from "@/lib/facebook-posts";

// Shared by the comment routes: find the post a request is about, and turn failures into responses.

export const kindSchema = z.enum(["app", "feed"]);

export async function loadTarget(userId: string, kind: unknown, id: string) {
  const parsedKind = kindSchema.safeParse(kind);
  if (!parsedKind.success || !z.string().uuid().safeParse(id).success) return { response: apiError("INVALID_REQUEST", 400) };
  const resolved = await resolveCommentTarget(userId, parsedKind.data, id);
  if (resolved.ok) return { target: resolved.target };
  if (resolved.code === "DB_ERROR") return { response: apiError("DB_ERROR", 500) };
  if (resolved.code === "POST_NOT_FOUND") return { response: apiError("POST_NOT_FOUND", 404) };
  return { response: failureResponse(resolved.code) };
}

/** A user may only do so many comment actions per minute (counted from the log). Null = allowed. */
export async function tooManyActions(userId: string) {
  try {
    return (await commentActionsRecently(userId)) >= MAX_COMMENT_ACTIONS_PER_MINUTE ? apiError("RATE_LIMITED", 429) : null;
  } catch (e) {
    return apiError("DB_ERROR", 500, { detail: e });
  }
}

export function failure(e: unknown) {
  const f = e instanceof FacebookActionError ? e : new FacebookActionError("UNEXPECTED", false, e);
  return failureResponse(f.code, f.cause);
}

/** Comments are other people's content: never cached anywhere. */
export const noStore = <T>(body: T, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
