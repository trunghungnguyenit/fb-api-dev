import { env } from "@/lib/env";

const REQUEST_TIMEOUT_MS = 15_000;
// Creating a post with a link makes Meta fetch the preview first; a real post took ~21s, so 15s would have
// reported a success as AMBIGUOUS. Together with the job budget it stays under the 60s serverless limit.
export const PUBLISH_TIMEOUT_MS = 30_000;

const graphRoot = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

export type MetaPage = {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
};

async function metaRequest<T>(url: URL | string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  if (!response.ok || body.error) throw metaErrorFrom(body, response.status);
  return body as T;
}

export async function metaGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${graphRoot}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Use Authorization header rather than putting secrets in URLs/logs.
  return metaRequest<T>(url, { headers: { Authorization: `Bearer ${token}` } });
}

export async function metaPost<T>(path: string, token: string, data: Record<string, string>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return metaRequest<T>(`${graphRoot}/${path.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data)
  }, timeoutMs);
}

export async function metaDelete<T>(path: string, token: string): Promise<T> {
  return metaRequest<T>(`${graphRoot}/${path.replace(/^\/+/, "")}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` }
  });
}

export class MetaApiError extends Error {
  code: string;
  httpStatus: number;
  /** Meta's error_subcode / fbtrace_id: kept for server logs only, never shown to users. */
  subcode?: string;
  traceId?: string;
  constructor(message: string, code: string, httpStatus: number, extra: { subcode?: string; traceId?: string } = {}) {
    super(message);
    this.name = "MetaApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.subcode = extra.subcode;
    this.traceId = extra.traceId;
  }
}

function metaErrorFrom(body: { error?: Record<string, unknown> }, status: number) {
  const err = body.error ?? {};
  return new MetaApiError(
    String(err.message ?? "Meta API request failed"), String(err.code ?? status), status,
    { subcode: err.error_subcode === undefined ? undefined : String(err.error_subcode), traceId: err.fbtrace_id === undefined ? undefined : String(err.fbtrace_id) }
  );
}
