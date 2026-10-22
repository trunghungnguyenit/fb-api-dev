import { supabaseAdmin } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/media/types";

// Thin wrapper over the private Storage bucket. The bucket is never public: browsers upload with a one-time
// signed upload URL, and Meta / the page previews read through short-lived signed URLs.

const bucket = () => supabaseAdmin.storage.from(MEDIA_BUCKET);

/** Where a file lives: one folder per user and media row, so names never collide and ownership is visible. */
export const mediaPath = (userId: string, mediaId: string, fileName: string) => `${userId}/${mediaId}/${fileName}`;

export type StorageProblem = Error & { status?: number; storageError?: unknown };

function problem(action: string, error: { message?: string; status?: number; statusCode?: string | number }): StorageProblem {
  const e: StorageProblem = new Error(`Storage ${action} failed: ${error.message ?? "unknown error"}`);
  const status = Number(error.status ?? error.statusCode);
  if (Number.isFinite(status)) e.status = status;
  e.storageError = error;
  return e;
}

const isNotFound = (error: { message?: string; status?: number; statusCode?: string | number }) =>
  [400, 404].includes(Number(error.status ?? error.statusCode)) || /not.?found|does not exist/i.test(error.message ?? "");

/** A one-time URL the browser PUTs the file to (no session needed, valid for a short while, for this path only). */
export async function createUploadTarget(path: string): Promise<{ url: string; token: string }> {
  const { data, error } = await bucket().createSignedUploadUrl(path);
  if (error || !data) throw problem("createSignedUploadUrl", error ?? {});
  return { url: data.signedUrl, token: data.token };
}

/** What is REALLY stored at `path` (size and content type as Storage recorded them), or null if nothing is there. */
export async function statObject(path: string): Promise<{ size: number; mime: string } | null> {
  const { data, error } = await bucket().info(path);
  if (error) {
    if (isNotFound(error)) return null;
    throw problem("info", error);
  }
  if (!data || typeof data.size !== "number") return null;
  return { size: data.size, mime: data.contentType ?? "" };
}

export async function signedUrl(path: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await bucket().createSignedUrl(path, ttlSeconds);
  if (error || !data) throw problem("createSignedUrl", error ?? {});
  return data.signedUrl;
}

/** Signed URLs for several paths at once; a path with no file simply has no entry. */
export async function signedUrls(paths: string[], ttlSeconds: number): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!paths.length) return result;
  const { data, error } = await bucket().createSignedUrls(paths, ttlSeconds);
  if (error) throw problem("createSignedUrls", error);
  for (const item of data ?? []) if (item.signedUrl && item.path) result.set(item.path, item.signedUrl);
  return result;
}

/** The first bytes of a stored file (to check what it really is) without downloading all of it. */
export async function readHead(path: string, bytes = 16): Promise<Uint8Array> {
  const url = await signedUrl(path, 60);
  const response = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok && response.status !== 206) {
    const e: StorageProblem = new Error(`Storage read failed with HTTP ${response.status}`);
    e.status = response.status;
    throw e;
  }
  // A server that ignores Range sends the whole file: keep only the head.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < bytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const head = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { head.set(chunk, offset); offset += chunk.length; }
  return head.slice(0, bytes);
}

/** The whole file (used only to send a video's bytes to Facebook from this server; files are capped by configuration). */
export async function downloadObject(path: string): Promise<Uint8Array> {
  const url = await signedUrl(path, 300);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const e: StorageProblem = new Error(`Storage download failed with HTTP ${response.status}`);
    e.status = response.status;
    throw e;
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Deletes files. A file that is already gone is not an error (deleting must be safe to repeat). */
export async function removeObjects(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await bucket().remove(paths);
  if (error && !isNotFound(error)) throw problem("remove", error);
}
