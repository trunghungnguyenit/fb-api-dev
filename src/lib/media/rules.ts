// Pure rules for uploaded media (no I/O): what is allowed, and whether a file / a post's set of files passes.
// The three server-side checks (before upload, after upload, at publish time) all call these.
import { formatMb, limitFor, type MediaKind, type MediaLimits } from "@/lib/media/limits";
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES } from "@/lib/media/types";

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type VideoMime = (typeof VIDEO_MIME_TYPES)[number];
export type FileMime = ImageMime | VideoMime;

const EXTENSION: Record<FileMime, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov"
};

export const isImageMime = (mime: string): mime is ImageMime => (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
export const isVideoMime = (mime: string): mime is VideoMime => (VIDEO_MIME_TYPES as readonly string[]).includes(mime);
/** A video or a Reel (as opposed to an image). */
export const isVideoKind = (kind: MediaKind) => kind !== "image";
export const isAllowedMime = (kind: MediaKind, mime: string): mime is FileMime => (isVideoKind(kind) ? isVideoMime(mime) : isImageMime(mime));

/** Wording for messages: "ảnh", "video", "Reels". */
export const noun = (kind: MediaKind) => (kind === "image" ? "ảnh" : kind === "reel" ? "Reels" : "video");

/** The file type from its first bytes. A file's claimed type is only a claim; this is what it really is. */
export function sniffImageType(head: Uint8Array): ImageMime | null {
  const at = (i: number) => head[i];
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "image/png";
  if (head.length >= 6 && String.fromCharCode(...head.slice(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
  return null;
}

/** MP4 and MOV both start with an `ftyp` box: size (4 bytes), "ftyp", then a brand. QuickTime's brand is "qt  ". */
export function sniffVideoType(head: Uint8Array): VideoMime | null {
  if (head.length < 12) return null;
  if (String.fromCharCode(...head.slice(4, 8)) !== "ftyp") return null;
  return String.fromCharCode(...head.slice(8, 12)) === "qt  " ? "video/quicktime" : "video/mp4";
}

export const sniffFileType = (kind: MediaKind, head: Uint8Array): FileMime | null => (isVideoKind(kind) ? sniffVideoType(head) : sniffImageType(head));

/** A storage-safe name: ASCII letters, digits, dash, underscore, and the extension that matches the real type. */
export function safeFileName(name: string | undefined, mime: FileMime) {
  const base = (name ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D") // the one Vietnamese letter that does not decompose
    .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || (isVideoMime(mime) ? "video" : "image")}.${EXTENSION[mime]}`;
}

export type MediaProblem = {
  code: "MEDIA_TYPE_INVALID" | "MEDIA_TOO_LARGE" | "MEDIA_TOO_MANY" | "MEDIA_TOTAL_TOO_LARGE" | "MEDIA_MISMATCH" | "MEDIA_EMPTY" | "MEDIA_MIXED";
  /** User-facing text with the configured numbers filled in. */
  message: string;
};
export type MediaCheck = { ok: true } | ({ ok: false } & MediaProblem);

const fail = (code: MediaProblem["code"], message: string): MediaCheck => ({ ok: false, code, message });

const allowedText = (kind: MediaKind) => (isVideoKind(kind) ? "video MP4 hoặc MOV" : "ảnh JPG, PNG hoặc GIF");

/** Layer 1: what the client says it is about to upload (cheap, before a signed URL is handed out). */
export function checkDeclaredFile(file: { kind: MediaKind; mime: string; size: number }, limits: MediaLimits): MediaCheck {
  if (!isAllowedMime(file.kind, file.mime)) return fail("MEDIA_TYPE_INVALID", `Chỉ hỗ trợ ${allowedText(file.kind)}.`);
  if (!Number.isFinite(file.size) || file.size <= 0) return fail("MEDIA_EMPTY", `Tệp ${noun(file.kind)} trống.`);
  const max = limitFor(limits, file.kind);
  if (file.size > max) return fail("MEDIA_TOO_LARGE", `Mỗi ${noun(file.kind)} tối đa ${formatMb(max)}.`);
  return { ok: true };
}

/** Layer 2 and 3: what is REALLY in storage (actual size, actual first bytes) against the current limits. */
export function checkStoredFile(
  file: { kind: MediaKind; declaredMime: string; actualSize: number; head: Uint8Array }, limits: MediaLimits
): MediaCheck {
  if (!Number.isFinite(file.actualSize) || file.actualSize <= 0) return fail("MEDIA_EMPTY", `Tệp ${noun(file.kind)} trống.`);
  const max = limitFor(limits, file.kind);
  if (file.actualSize > max) return fail("MEDIA_TOO_LARGE", `Mỗi ${noun(file.kind)} tối đa ${formatMb(max)}.`);
  const real = sniffFileType(file.kind, file.head);
  if (!real) return fail("MEDIA_TYPE_INVALID", `Tệp không phải ${allowedText(file.kind)} hợp lệ.`);
  if (real !== file.declaredMime) return fail("MEDIA_MISMATCH", `Nội dung tệp không khớp với loại ${noun(file.kind)} đã khai báo.`);
  return { ok: true };
}

/** The images of one post together: how many, and how big in total. */
export function checkImageSet(sizes: number[], limits: MediaLimits): MediaCheck {
  if (sizes.length > limits.imagesPerPost) return fail("MEDIA_TOO_MANY", `Mỗi bài tối đa ${limits.imagesPerPost} ảnh.`);
  if (sizes.length > 1 && sizes.reduce((a, b) => a + b, 0) > limits.imagesTotalBytes) {
    return fail("MEDIA_TOTAL_TOO_LARGE", `Tổng dung lượng ảnh của một bài tối đa ${formatMb(limits.imagesTotalBytes)}.`);
  }
  return { ok: true };
}

/** All the files of one post: several images, OR exactly one video / Reel, never a mix. */
export function checkMediaSet(files: { kind: MediaKind; size: number }[], limits: MediaLimits): MediaCheck {
  const videos = files.filter((f) => isVideoKind(f.kind));
  if (videos.length && files.length > 1) return fail("MEDIA_MIXED", "Một bài chỉ có ảnh, hoặc đúng một video / Reels, không trộn lẫn.");
  if (videos.length) return { ok: true };
  return checkImageSet(files.map((f) => f.size), limits);
}

export type PostType = "text" | "link" | "photo" | "photos" | "video" | "reel";

/** Posts that are slow to publish (several images, video, Reels): they use the heavy lane and are never published inline. */
export const isHeavyPostType = (postType: string | null | undefined) => postType === "photos" || postType === "video" || postType === "reel";

/** The post type follows from what the post contains, so it can never disagree with its media. */
export function derivePostType(input: { linkUrl?: string | null; media: { kind: MediaKind }[] }): PostType {
  const first = input.media[0];
  if (first?.kind === "video") return "video";
  if (first?.kind === "reel") return "reel";
  if (input.media.length === 1) return "photo";
  if (input.media.length > 1) return "photos";
  return input.linkUrl ? "link" : "text";
}
