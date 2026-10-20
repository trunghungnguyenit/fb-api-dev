import { metaGet, MetaApiError, type MetaPage } from "@/lib/meta/client";
import type { ErrorCode } from "@/lib/errors";

const MAX_BATCHES = 50; // 50 x 100 = 5000 pages; beyond that we refuse rather than act on a partial list

/** All Pages the user manages, following cursor pagination. Throws if the list may be incomplete. */
export async function fetchAllManagedPages(userToken: string): Promise<MetaPage[]> {
  const all: MetaPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await metaGet<{ data?: MetaPage[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      "me/accounts", userToken,
      { fields: "id,name,access_token,tasks", limit: "100", ...(after ? { after } : {}) }
    );
    all.push(...(res.data ?? []));
    if (!res.paging?.next) return all;
    // paging.next embeds the access token, so only the cursor is used. A `next` without a cursor
    // means we cannot continue: fail rather than return a list that looks complete but is not.
    const cursor = res.paging.cursors?.after;
    if (!cursor) throw new Error("me/accounts has more pages but no cursor");
    after = cursor;
  }
  throw new Error("me/accounts exceeded pagination limit");
}

// Codes that mean the TOKEN itself is dead (expired, revoked, session invalid, user removed the app).
// Deliberately excludes 10 / 200 / 283 / 459: those can be app-level (review, Live mode), per-action,
// or a checkpoint the user can clear, so one of them must never switch a whole Page off.
const DEAD_TOKEN_CODES = new Set(["190", "102", "467"]);
const PERMISSION_DENIED_CODES = new Set(["10", "200", "283", "459"]);

export function isPermissionError(error: unknown): error is MetaApiError {
  return error instanceof MetaApiError && DEAD_TOKEN_CODES.has(error.code);
}

/** Maps a Meta API rejection to one of our user-facing error codes. */
export function describeMetaError(error: MetaApiError): ErrorCode {
  if (DEAD_TOKEN_CODES.has(error.code)) return "PAGE_PERMISSION_LOST";
  if (PERMISSION_DENIED_CODES.has(error.code)) return "FB_PERMISSION_DENIED";
  if (error.code === "368") return "FB_TEMP_BLOCKED";
  if (["4", "17", "32", "613", "80001", "80006"].includes(error.code)) return "FB_RATE_LIMITED";
  if (error.code === "506") return "FB_DUPLICATE";
  if (["100", "120", "1500"].includes(error.code)) return "FB_CONTENT_REJECTED";
  if (["1", "2"].includes(error.code) || error.httpStatus >= 500) return "FB_UNAVAILABLE";
  return "FB_REJECTED";
}
