// Pure helpers for the file columns of an import: which files a row names, and what its "Loại bài" cell says.
import { normalizeHeader } from "./columns";
import type { PostType } from "@/lib/media/rules";

/** The files a "Tệp đính kèm" cell names, in order. Separators: ";", "|" or a new line (a name may contain a comma). */
export const splitFileNames = (cell: string) => cell.split(/[;|\n]+/).map((s) => s.trim()).filter(Boolean);

/** The same file written with other case or accents composition is the same file. */
export const fileKey = (name: string) => name.normalize("NFC").trim().toLowerCase();

/** A file the user picked in the browser: only what the server needs to check, never the bytes. */
export type DeclaredFile = { name: string; size: number; mime: string };

const TYPE_WORDS: Record<string, PostType> = {
  baiviet: "text", text: "text", vanban: "text", status: "text",
  lienket: "link", link: "link",
  anh: "photo", photo: "photo", hinhanh: "photo", "1anh": "photo", motanh: "photo",
  nhieuanh: "photos", photos: "photos", album: "photos", albums: "photos",
  video: "video",
  reel: "reel", reels: "reel"
};

/** "" = the cell is empty (the type follows from the files), null = a word we do not know. */
export function parseTypeCell(cell: string): PostType | "" | null {
  const key = normalizeHeader(cell);
  if (!key) return "";
  return TYPE_WORDS[key] ?? null;
}

export const POST_TYPE_LABELS: Record<PostType, string> = {
  text: "Bài viết", link: "Bài có liên kết", photo: "1 ảnh", photos: "Nhiều ảnh", video: "Video", reel: "Reels"
};
