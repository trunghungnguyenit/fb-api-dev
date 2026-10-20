import { messageFor, withRef } from "@/lib/errors";

/** Error whose text is already safe and in Vietnamese. Anything else is replaced by a generic message. */
export class UserError extends Error {}

/** A UserError from one of our API responses; keeps the error code and the parsed body for callers that branch on them. */
export class ApiFailure extends UserError {
  constructor(message: string, public code: string | null, public body: unknown) {
    super(message);
  }
}

export function userMessage(e: unknown) {
  return e instanceof UserError ? e.message : messageFor("UNEXPECTED");
}

/** fetch + JSON for our own API. Network/HTML/backend failures all become a friendly UserError. */
export async function callApi<T = { post?: { status?: string; last_error_code?: string | null } }>(
  url: string, init: { method: string; body?: unknown }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method, headers: { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch {
    throw new UserError(messageFor("NETWORK"));
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const text = typeof result?.error === "string" ? result.error : messageFor("UNEXPECTED");
    throw new ApiFailure(withRef(text, result?.ref), typeof result?.code === "string" ? result.code : null, result);
  }
  return result as T;
}
