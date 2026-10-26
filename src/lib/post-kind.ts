// Pure module (client and server): the five kinds of post the forms offer, and how they map to what is stored.
// A form shows only the fields of the chosen kind; the kind itself is never stored, the stored `post_type` follows
// from the content (see derivePostType in media/rules.ts), so the two can never disagree.
import type { MediaKind } from "@/lib/media/limits";

export type PostKind = "text" | "link" | "images" | "video" | "reel";

export const POST_KINDS: readonly PostKind[] = ["text", "link", "images", "video", "reel"];

export const KIND_INFO: Record<PostKind, { label: string; hint: string }> = {
  text: { label: "Bài viết", hint: "Chỉ có chữ." },
  link: { label: "Bài viết + Liên kết", hint: "Chữ kèm một liên kết; Facebook tự tạo thẻ xem trước của liên kết." },
  images: { label: "Bài viết + Ảnh", hint: "Một hoặc nhiều ảnh. Chú thích không bắt buộc." },
  video: { label: "Bài viết + Video", hint: "Một video MP4 hoặc MOV. Chú thích không bắt buộc." },
  reel: { label: "Reels", hint: "Một video dọc 9:16, dài 3–90 giây. Chú thích không bắt buộc." }
};

/** The kind of file a post of this kind carries, or null when it carries none. */
export function mediaKindOf(kind: PostKind): MediaKind | null {
  return kind === "images" ? "image" : kind === "video" ? "video" : kind === "reel" ? "reel" : null;
}

/** The kind that matches a stored `post_type` (text, link, photo, photos, video, reel). Unknown values read as text. */
export function kindOfPostType(postType: string | null | undefined): PostKind {
  switch (postType) {
    case "photo": case "photos": return "images";
    case "video": return "video";
    case "reel": return "reel";
    case "link": return "link";
    default: return "text";
  }
}

/** The kind of a post that is being copied or edited, from what it contains (used when `post_type` is not at hand). */
export function kindOfContent(content: { postType?: string | null; linkUrl?: string | null; mediaKinds?: MediaKind[] }): PostKind {
  const first = content.mediaKinds?.[0];
  if (first) return first === "image" ? "images" : first;
  if (content.postType) return kindOfPostType(content.postType);
  return content.linkUrl ? "link" : "text";
}
