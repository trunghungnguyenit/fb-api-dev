import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ErrorCode } from "@/lib/errors";
import { mediaLimits } from "@/lib/media/config";
import type { MediaLimits } from "@/lib/media/limits";
import { checkMediaSet, checkStoredFile } from "@/lib/media/rules";
import { readHead, signedUrl, statObject } from "@/lib/media/storage";

// The publisher's side of media: re-check the files right before they are sent to Facebook, and build the Graph
// requests. The checks run AGAIN here on purpose: a row may have been edited, a stored object replaced, or the
// limits lowered after the post was scheduled. Nothing has been sent to Facebook when any of this fails.

/** A media problem found before anything was sent. `code` is a user-facing error code. */
export class MediaProblemError extends Error {
  constructor(public code: ErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = "MediaProblemError";
  }
}

export type PreparedImage = {
  id: string; kind: "image" | "video" | "reel"; url: string; storage_path: string; mime: string; facebook_media_id: string | null;
};

/** How long the signed link Facebook downloads the image from stays valid. */
const FACEBOOK_FETCH_TTL_SECONDS = 60 * 60;

type Row = { id: string; kind: "image" | "video" | "reel"; storage_path: string; mime: string; facebook_media_id: string | null; state: string };

/**
 * The files of a post (images, or one video / Reel), verified against storage and the CURRENT limits, with a short-lived signed URL each.
 * Throws MediaProblemError: MEDIA_MISSING / MEDIA_TOO_LARGE / ... (the post fails, nothing was sent) or
 * MEDIA_STORAGE_ERROR / DB_ERROR (transient: the post goes back in the queue).
 */
export async function preparePublishMedia(
  post: { id: string; user_id: string }, limits: MediaLimits = mediaLimits
): Promise<PreparedImage[]> {
  const { data, error } = await supabaseAdmin.from("post_media")
    .select("id,kind,storage_path,mime,facebook_media_id,state")
    .eq("post_id", post.id).eq("user_id", post.user_id).order("position", { ascending: true });
  if (error) throw new MediaProblemError("DB_ERROR", error);
  const files = (data ?? []) as unknown as Row[];
  if (!files.length || files.some((f) => f.state !== "uploaded")) throw new MediaProblemError("MEDIA_MISSING");

  const sizes: number[] = [];
  for (const file of files) {
    try {
      const stored = await statObject(file.storage_path);
      if (!stored) throw new MediaProblemError("MEDIA_MISSING");
      const head = await readHead(file.storage_path, 16);
      const check = checkStoredFile({ kind: file.kind, declaredMime: file.mime, actualSize: stored.size, head }, limits);
      if (!check.ok) throw new MediaProblemError(check.code);
      sizes.push(stored.size);
    } catch (e) {
      if (e instanceof MediaProblemError) throw e;
      throw new MediaProblemError("MEDIA_STORAGE_ERROR", e);
    }
  }
  const set = checkMediaSet(files.map((f, i) => ({ kind: f.kind, size: sizes[i] })), limits);
  if (!set.ok) throw new MediaProblemError(set.code);

  try {
    return await Promise.all(files.map(async (f) => ({
      id: f.id, kind: f.kind, storage_path: f.storage_path, mime: f.mime, facebook_media_id: f.facebook_media_id,
      url: await signedUrl(f.storage_path, FACEBOOK_FETCH_TTL_SECONDS)
    })));
  } catch (e) {
    throw new MediaProblemError("MEDIA_STORAGE_ERROR", e);
  }
}

/** Remembers Facebook's id for an unpublished upload, so a retry of the post does not upload the photo again. */
export async function recordFacebookMediaId(mediaId: string, facebookMediaId: string) {
  const { error } = await supabaseAdmin.from("post_media").update({ facebook_media_id: facebookMediaId }).eq("id", mediaId);
  if (error) console.error(`could not store the Facebook photo id for media ${mediaId}:`, error);
}

// ---- Graph requests (pure) -------------------------------------------------------------------------------------

export type GraphRequest = { path: string; params: Record<string, string> };

/** Text or link post. */
export function feedRequest(pageFbId: string, post: { message: string; link_url: string | null }): GraphRequest {
  const params: Record<string, string> = { message: post.message };
  if (post.link_url) params.link = post.link_url;
  return { path: `${pageFbId}/feed`, params };
}

/** One image, published straight away; the caption is the post's text. */
export function singlePhotoRequest(pageFbId: string, url: string, message: string): GraphRequest {
  const params: Record<string, string> = { url, published: "true" };
  if (message) params.caption = message;
  return { path: `${pageFbId}/photos`, params };
}

/** Step 1 of a multi-photo post: the image is uploaded but not shown anywhere yet. */
export function unpublishedPhotoRequest(pageFbId: string, url: string): GraphRequest {
  return { path: `${pageFbId}/photos`, params: { url, published: "false" } };
}

/** Step 2 of a multi-photo post: one feed post that attaches the uploaded images, in order. */
export function multiPhotoRequest(pageFbId: string, message: string, facebookMediaIds: string[]): GraphRequest {
  const params: Record<string, string> = {};
  if (message) params.message = message;
  facebookMediaIds.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return { path: `${pageFbId}/feed`, params };
}

/** The id of the post Facebook created: a photo post answers with `post_id` (the feed story) next to `id` (the photo). */
export const createdPostId = (result: { id?: string; post_id?: string }) => result.post_id ?? result.id;
