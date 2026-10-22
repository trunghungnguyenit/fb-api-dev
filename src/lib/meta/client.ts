import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { isRateLimitCode, LOCAL_RATE_LIMIT_CODE, parseUsageHeaders, usageTracker } from "@/lib/meta/usage";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Usage is tracked per access token (a Page token = one Page); the id is a fingerprint, never the token itself.
const bucketOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

async function metaRequest<T>(url: URL | string, init: RequestInit, token: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const bucket = bucketOf(token);
  // Back off before Meta starts rejecting us: a blocked bucket never reaches the network, a busy one is slowed.
  const gate = usageTracker.gate(bucket);
  if (gate.blockedUntil) throw new MetaRateLimitedError(gate.blockedUntil);
  if (gate.delayMs) await sleep(gate.delayMs);

  const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const usage = parseUsageHeaders(response.headers);
  usageTracker.record(bucket, usage);
  const body = await response.json();
  if (!response.ok || body.error) {
    const error = metaErrorFrom(body, response.status);
    if (isRateLimitCode(error.code)) {
      const retryAfterMs = Number(response.headers.get("retry-after")) * 1000 || 0;
      error.retryAt = usageTracker.noteRateLimited(bucket, error.code, usage.business?.regainMs || retryAfterMs);
    }
    throw error;
  }
  usageTracker.noteSuccess(bucket);
  return body as T;
}

export async function metaGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${graphRoot}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Use Authorization header rather than putting secrets in URLs/logs.
  return metaRequest<T>(url, { headers: { Authorization: `Bearer ${token}` } }, token);
}

export async function metaPost<T>(path: string, token: string, data: Record<string, string>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return metaRequest<T>(`${graphRoot}/${path.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data)
  }, token, timeoutMs);
}

export async function metaDelete<T>(path: string, token: string): Promise<T> {
  return metaRequest<T>(`${graphRoot}/${path.replace(/^\/+/, "")}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` }
  }, token);
}

// ---- Video uploads --------------------------------------------------------------------------------------------------
// Reels are uploaded to a separate host (rupload.facebook.com) that the "start" call hands back, and a plain video
// can be sent as a multipart file to graph-video.facebook.com. Both are authorised with the Page token.

/** Upload hosts are Meta's own; never send a token anywhere else, whatever a response says. */
export function isMetaUploadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"));
  } catch { return false; }
}

/** The rupload address of a Reel's upload session (the documented pattern, used when the start answer is not at hand). */
export const reelUploadUrl = (videoId: string) => `https://rupload.facebook.com/video-upload/${env.META_GRAPH_API_VERSION}/${videoId}`;

async function uploadRequest(url: string, init: RequestInit, timeoutMs: number) {
  if (!isMetaUploadUrl(url)) throw new Error("Refusing to upload to a host that is not Facebook's");
  const response = await fetch(url, { ...init, method: "POST", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || body.success === false) throw metaErrorFrom(body, response.status);
  return body as { success?: boolean };
}

/** Reel step 2, hosted: Facebook downloads the file itself from `fileUrl` (must be reachable by facebookexternalhit). */
export function metaUploadFromUrl(uploadUrl: string, token: string, fileUrl: string, timeoutMs: number) {
  return uploadRequest(uploadUrl, { headers: { Authorization: `OAuth ${token}`, file_url: fileUrl } }, timeoutMs);
}

/** Reel step 2, direct: the file's bytes are sent from here. */
export function metaUploadBytes(uploadUrl: string, token: string, data: Uint8Array, timeoutMs: number) {
  return uploadRequest(uploadUrl, {
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(data.byteLength), "Content-Type": "application/octet-stream" },
    body: data as unknown as BodyInit
  }, timeoutMs);
}

/** Plain video, direct: POST /{page}/videos as multipart with the file in `source`. */
export async function metaPostVideoFile<T>(
  path: string, token: string, fields: Record<string, string>, file: { name: string; type: string; data: Uint8Array }, timeoutMs: number
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("source", new Blob([file.data as unknown as BlobPart], { type: file.type }), file.name);
  const url = `https://graph-video.facebook.com/${env.META_GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`;
  const response = await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, cache: "no-store", signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok || body.error) throw metaErrorFrom(body, response.status);
  return body as T;
}

export class MetaApiError extends Error {
  code: string;
  httpStatus: number;
  /** Meta's error_subcode / fbtrace_id: kept for server logs only, never shown to users. */
  subcode?: string;
  traceId?: string;
  /** Set on rate-limit rejections: when (epoch ms) calls may resume. */
  retryAt?: number;
  constructor(message: string, code: string, httpStatus: number, extra: { subcode?: string; traceId?: string } = {}) {
    super(message);
    this.name = "MetaApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.subcode = extra.subcode;
    this.traceId = extra.traceId;
  }
}

/** Thrown WITHOUT sending anything: this token's (or the app's) rate-limit allowance is used up until `retryAt`. */
export class MetaRateLimitedError extends MetaApiError {
  constructor(retryAt: number) {
    super("Meta rate limit reached; waiting before the next call", LOCAL_RATE_LIMIT_CODE, 429);
    this.name = "MetaRateLimitedError";
    this.retryAt = retryAt;
  }
}

function metaErrorFrom(body: { error?: Record<string, unknown> }, status: number) {
  const err = body.error ?? {};
  return new MetaApiError(
    String(err.message ?? "Meta API request failed"), String(err.code ?? status), status,
    { subcode: err.error_subcode === undefined ? undefined : String(err.error_subcode), traceId: err.fbtrace_id === undefined ? undefined : String(err.fbtrace_id) }
  );
}
