import { describe, expect, it } from "vitest";
import { buildLimits, clientLimits, formatMb, limitFor } from "@/lib/media/limits";
import {
  checkDeclaredFile, checkImageSet, checkMediaSet, checkStoredFile, derivePostType, isHeavyPostType, safeFileName, sniffImageType, sniffVideoType
} from "@/lib/media/rules";

const MB = 1024 * 1024;
const bytes = (...b: number[]) => Uint8Array.from(b);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const GIF = Uint8Array.from(Buffer.from("GIF89a....."));

describe("buildLimits", () => {
  it("has the agreed defaults: 50 MB ceiling, 10 MB per image, 50 MB total, 10 images", () => {
    const l = buildLimits({});
    expect(l.maxFileBytes).toBe(50 * MB);
    expect(limitFor(l, "image")).toBe(10 * MB);
    expect(limitFor(l, "video")).toBe(50 * MB);
    expect(limitFor(l, "reel")).toBe(50 * MB);
    expect(l.imagesTotalBytes).toBe(50 * MB);
    expect(l.imagesPerPost).toBe(10);
  });

  it("reads overrides, and a kind limit can never exceed the ceiling", () => {
    const l = buildLimits({ MEDIA_MAX_FILE_MB: "20", MEDIA_MAX_IMAGE_MB: "50", MEDIA_MAX_VIDEO_MB: "15", MEDIA_MAX_IMAGES_PER_POST: "4" });
    expect(limitFor(l, "image")).toBe(20 * MB); // 50 asked, ceiling 20
    expect(limitFor(l, "video")).toBe(15 * MB);
    expect(l.imagesPerPost).toBe(4);
  });

  it("raising the ceiling is all it takes to allow bigger files", () => {
    const l = buildLimits({ MEDIA_MAX_FILE_MB: "500", MEDIA_MAX_VIDEO_MB: "500", MEDIA_MAX_REEL_MB: "500" });
    expect(limitFor(l, "video")).toBe(500 * MB);
    expect(limitFor(l, "image")).toBe(10 * MB);
  });

  it("treats blank values as unset and rejects values that cannot be right", () => {
    expect(buildLimits({ MEDIA_MAX_FILE_MB: "  ", MEDIA_MAX_IMAGES_PER_POST: "" }).maxFileBytes).toBe(50 * MB);
    for (const bad of ["abc", "0", "-5", "NaN", "1e9"]) expect(() => buildLimits({ MEDIA_MAX_FILE_MB: bad })).toThrow(/MEDIA_MAX_FILE_MB/);
    for (const bad of ["0", "2.5", "31", "x"]) expect(() => buildLimits({ MEDIA_MAX_IMAGES_PER_POST: bad })).toThrow(/MEDIA_MAX_IMAGES_PER_POST/);
  });

  it("formats sizes for messages and exposes only what the browser needs", () => {
    expect(formatMb(10 * MB)).toBe("10 MB");
    expect(formatMb(2.5 * MB)).toBe("2,5 MB");
    expect(clientLimits(buildLimits({}))).toEqual({ imageBytes: 10 * MB, videoBytes: 50 * MB, reelBytes: 50 * MB, imagesTotalBytes: 50 * MB, imagesPerPost: 10, importFiles: 50, importTotalBytes: 500 * MB });
  });
});

describe("sniffImageType", () => {
  it("recognises JPEG, PNG and GIF by their first bytes only", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(Uint8Array.from(Buffer.from("GIF87a")))).toBe("image/gif");
  });

  it("rejects everything else, including WebP, HTML and truncated data", () => {
    expect(sniffImageType(Uint8Array.from(Buffer.from("RIFF....WEBPVP8 ")))).toBeNull();
    expect(sniffImageType(Uint8Array.from(Buffer.from("<html><script>")))).toBeNull();
    expect(sniffImageType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("safeFileName", () => {
  it("keeps storage paths plain and the extension truthful", () => {
    expect(safeFileName("Ảnh sản phẩm (1).PNG", "image/png")).toBe("Anh-san-pham-1.png");
    expect(safeFileName("../../etc/passwd", "image/jpeg")).toBe("etc-passwd.jpg");
    expect(safeFileName(undefined, "image/gif")).toBe("image.gif");
    expect(safeFileName("???", "image/jpeg")).toBe("image.jpg");
    expect(safeFileName("a".repeat(200), "image/jpeg").length).toBeLessThanOrEqual(64);
  });
});

describe("checkDeclaredFile (before upload)", () => {
  const limits = buildLimits({});
  const ok = { kind: "image" as const, mime: "image/png", size: 2 * MB };

  it("accepts an allowed type within the limit", () => {
    expect(checkDeclaredFile(ok, limits)).toEqual({ ok: true });
    expect(checkDeclaredFile({ ...ok, size: 10 * MB }, limits)).toEqual({ ok: true });
  });

  it("rejects over-limit files with the configured number in the message", () => {
    const r = checkDeclaredFile({ ...ok, size: 10 * MB + 1 }, limits);
    expect(r).toMatchObject({ ok: false, code: "MEDIA_TOO_LARGE" });
    expect(r.ok === false && r.message).toContain("10 MB");
    const raised = checkDeclaredFile({ ...ok, size: 15 * MB }, buildLimits({ MEDIA_MAX_IMAGE_MB: "20" }));
    expect(raised).toEqual({ ok: true });
  });

  it("rejects other types, kinds, and empty or nonsensical sizes", () => {
    expect(checkDeclaredFile({ ...ok, mime: "image/webp" }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkDeclaredFile({ ...ok, mime: "text/html" }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkDeclaredFile({ ...ok, kind: "video" }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkDeclaredFile({ ...ok, size: 0 }, limits)).toMatchObject({ code: "MEDIA_EMPTY" });
    expect(checkDeclaredFile({ ...ok, size: NaN }, limits)).toMatchObject({ code: "MEDIA_EMPTY" });
  });
});

describe("checkStoredFile (what is really in storage)", () => {
  const limits = buildLimits({});
  const stored = { kind: "image" as const, declaredMime: "image/jpeg", actualSize: 3 * MB, head: JPEG };

  it("accepts a real image of the declared type", () => {
    expect(checkStoredFile(stored, limits)).toEqual({ ok: true });
  });

  it("rejects a file that is much bigger than declared", () => {
    // declared small at step 1, but the object that arrived is 40 MB
    expect(checkStoredFile({ ...stored, actualSize: 40 * MB }, limits)).toMatchObject({ ok: false, code: "MEDIA_TOO_LARGE" });
  });

  it("rejects a declared type that differs from the content, and content that is no image", () => {
    expect(checkStoredFile({ ...stored, declaredMime: "image/png" }, limits)).toMatchObject({ code: "MEDIA_MISMATCH" });
    expect(checkStoredFile({ ...stored, head: Uint8Array.from(Buffer.from("<script>alert(1)</script>")) }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkStoredFile({ ...stored, actualSize: 0 }, limits)).toMatchObject({ code: "MEDIA_EMPTY" });
  });

  it("applies a limit that was lowered after the file was uploaded", () => {
    expect(checkStoredFile(stored, buildLimits({ MEDIA_MAX_IMAGE_MB: "2" }))).toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });
});

describe("checkImageSet", () => {
  const limits = buildLimits({});

  it("limits how many images a post can have", () => {
    expect(checkImageSet(Array(10).fill(MB), limits)).toEqual({ ok: true });
    expect(checkImageSet(Array(11).fill(MB), limits)).toMatchObject({ ok: false, code: "MEDIA_TOO_MANY" });
  });

  it("limits the total size of a multi-photo post, but not a single photo", () => {
    expect(checkImageSet([10 * MB, 10 * MB, 10 * MB, 10 * MB, 10 * MB], limits)).toEqual({ ok: true });
    expect(checkImageSet([10 * MB, 10 * MB, 10 * MB, 10 * MB, 10 * MB, 1], limits)).toMatchObject({ code: "MEDIA_TOTAL_TOO_LARGE" });
    expect(checkImageSet([10 * MB], limits)).toEqual({ ok: true });
    expect(checkImageSet([], limits)).toEqual({ ok: true });
  });
});

describe("derivePostType", () => {
  it("follows from the content", () => {
    const img = { kind: "image" as const };
    expect(derivePostType({ media: [] })).toBe("text");
    expect(derivePostType({ media: [], linkUrl: "https://example.com" })).toBe("link");
    expect(derivePostType({ media: [], linkUrl: "" })).toBe("text");
    expect(derivePostType({ media: [img] })).toBe("photo");
    expect(derivePostType({ media: [img, img, img, img] })).toBe("photos");
    expect(derivePostType({ media: [{ kind: "video" }] })).toBe("video");
    expect(derivePostType({ media: [{ kind: "reel" }] })).toBe("reel");
  });
});

// ---- video and Reels ---------------------------------------------------------------------------------------
const mp4 = (brand: string) => Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftyp"), ...Buffer.from(brand), 0, 0, 0, 0]);

describe("sniffVideoType", () => {
  it("recognises MP4 and QuickTime by the ftyp box", () => {
    for (const brand of ["isom", "mp42", "avc1", "M4V "]) expect(sniffVideoType(mp4(brand))).toBe("video/mp4");
    expect(sniffVideoType(mp4("qt  "))).toBe("video/quicktime");
  });

  it("rejects anything else, including images, text and truncated data", () => {
    expect(sniffVideoType(JPEG)).toBeNull();
    expect(sniffVideoType(Uint8Array.from(Buffer.from("<html>................")))).toBeNull();
    expect(sniffVideoType(Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftyp")]))).toBeNull();
    expect(sniffVideoType(Uint8Array.from(Buffer.from("RIFF....AVI LIST")))).toBeNull();
  });
});

describe("video and Reels files", () => {
  const limits = buildLimits({});

  it("declared files use the video / Reels limit and types, with the right wording", () => {
    expect(checkDeclaredFile({ kind: "video", mime: "video/mp4", size: 50 * MB }, limits)).toEqual({ ok: true });
    expect(checkDeclaredFile({ kind: "reel", mime: "video/quicktime", size: 20 * MB }, limits)).toEqual({ ok: true });
    const big = checkDeclaredFile({ kind: "reel", mime: "video/mp4", size: 50 * MB + 1 }, limits);
    expect(big).toMatchObject({ ok: false, code: "MEDIA_TOO_LARGE" });
    expect(big.ok === false && big.message).toBe("Mỗi Reels tối đa 50 MB.");
    expect(checkDeclaredFile({ kind: "video", mime: "image/png", size: MB }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkDeclaredFile({ kind: "image", mime: "video/mp4", size: MB }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkDeclaredFile({ kind: "video", mime: "video/webm", size: MB }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
  });

  it("each kind has its own configured limit, and raising it needs no code change", () => {
    const l = buildLimits({ MEDIA_MAX_FILE_MB: "500", MEDIA_MAX_VIDEO_MB: "500", MEDIA_MAX_REEL_MB: "100" });
    expect(checkDeclaredFile({ kind: "video", mime: "video/mp4", size: 300 * MB }, l)).toEqual({ ok: true });
    expect(checkDeclaredFile({ kind: "reel", mime: "video/mp4", size: 300 * MB }, l)).toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("stored files are checked by what they really are", () => {
    const stored = { kind: "video" as const, declaredMime: "video/mp4", actualSize: 30 * MB, head: mp4("isom") };
    expect(checkStoredFile(stored, limits)).toEqual({ ok: true });
    expect(checkStoredFile({ ...stored, head: mp4("qt  ") }, limits)).toMatchObject({ code: "MEDIA_MISMATCH" });
    expect(checkStoredFile({ ...stored, head: JPEG }, limits)).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    expect(checkStoredFile({ ...stored, actualSize: 80 * MB }, limits)).toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("safeFileName gives videos their own extension", () => {
    expect(safeFileName("Clip quảng cáo.MOV", "video/quicktime")).toBe("Clip-quang-cao.mov");
    expect(safeFileName(undefined, "video/mp4")).toBe("video.mp4");
  });
});

describe("checkMediaSet", () => {
  const limits = buildLimits({});

  it("a post has several images, or exactly one video / Reel, never a mix", () => {
    expect(checkMediaSet([{ kind: "video", size: 40 * MB }], limits)).toEqual({ ok: true });
    expect(checkMediaSet([{ kind: "reel", size: 40 * MB }], limits)).toEqual({ ok: true });
    expect(checkMediaSet([{ kind: "video", size: MB }, { kind: "video", size: MB }], limits)).toMatchObject({ code: "MEDIA_MIXED" });
    expect(checkMediaSet([{ kind: "image", size: MB }, { kind: "reel", size: MB }], limits)).toMatchObject({ code: "MEDIA_MIXED" });
    expect(checkMediaSet([{ kind: "image", size: MB }, { kind: "image", size: MB }], limits)).toEqual({ ok: true });
    expect(checkMediaSet(Array(11).fill({ kind: "image", size: MB }), limits)).toMatchObject({ code: "MEDIA_TOO_MANY" });
  });
});

describe("isHeavyPostType", () => {
  it("is true for the slow kinds only", () => {
    for (const t of ["photos", "video", "reel"]) expect(isHeavyPostType(t)).toBe(true);
    for (const t of ["text", "link", "photo", null, undefined]) expect(isHeavyPostType(t)).toBe(false);
  });
});
