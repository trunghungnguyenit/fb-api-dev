import { describe, expect, it } from "vitest";
import { checkLink, checkMedia, checkMessage } from "@/lib/field-errors";
import { derivePostType } from "@/lib/media/rules";
import { KIND_INFO, kindOfContent, kindOfPostType, mediaKindOf, POST_KINDS } from "@/lib/post-kind";

describe("post kinds", () => {
  it("has a label and a hint for each of the five kinds", () => {
    expect(POST_KINDS).toEqual(["text", "link", "images", "video", "reel"]);
    for (const kind of POST_KINDS) expect(KIND_INFO[kind].label && KIND_INFO[kind].hint).toBeTruthy();
  });

  it("knows which kinds carry a file, and of what sort", () => {
    expect(POST_KINDS.map(mediaKindOf)).toEqual([null, null, "image", "video", "reel"]);
  });

  it("maps every stored post_type to a kind, and unknown values to a plain post", () => {
    expect(["text", "link", "photo", "photos", "video", "reel"].map(kindOfPostType)).toEqual(["text", "link", "images", "images", "video", "reel"]);
    expect(kindOfPostType(null)).toBe("text");
    expect(kindOfPostType("something-new")).toBe("text");
  });

  it("agrees with derivePostType: the kind chosen in the form is the post_type the server derives", () => {
    const cases = [
      { kind: "text" as const, linkUrl: null, media: [] },
      { kind: "link" as const, linkUrl: "https://a.vn", media: [] },
      { kind: "images" as const, linkUrl: null, media: [{ kind: "image" as const }] },
      { kind: "images" as const, linkUrl: null, media: [{ kind: "image" as const }, { kind: "image" as const }] },
      { kind: "video" as const, linkUrl: null, media: [{ kind: "video" as const }] },
      { kind: "reel" as const, linkUrl: null, media: [{ kind: "reel" as const }] }
    ];
    for (const c of cases) expect(kindOfPostType(derivePostType({ linkUrl: c.linkUrl, media: c.media }))).toBe(c.kind);
  });

  it("reads the kind of a post being copied from its files first, then its type, then its link", () => {
    expect(kindOfContent({ mediaKinds: ["image", "image"], linkUrl: "https://a.vn" })).toBe("images");
    expect(kindOfContent({ mediaKinds: ["reel"] })).toBe("reel");
    expect(kindOfContent({ postType: "photo", mediaKinds: [] })).toBe("images"); // its files were cleaned up, the kind stays
    expect(kindOfContent({ linkUrl: "https://a.vn" })).toBe("link");
    expect(kindOfContent({})).toBe("text");
  });
});

describe("what each kind requires", () => {
  it("a link kind needs a valid link; the others do not care", () => {
    expect(checkLink("", { required: true })).toMatch(/Nhập liên kết/);
    expect(checkLink("   ", { required: true })).toMatch(/Nhập liên kết/);
    expect(checkLink("", {})).toBeNull();
    expect(checkLink("https://ten-mien.com/bai", { required: true })).toBeNull();
    expect(checkLink("khong-phai-link", { required: true })).toMatch(/không hợp lệ/);
  });

  it("a kind with files needs at least one, worded for that kind", () => {
    expect(checkMedia("images", 0)).toMatch(/ít nhất một ảnh/);
    expect(checkMedia("video", 0)).toMatch(/một video/);
    expect(checkMedia("reel", 0)).toMatch(/Reels/);
    for (const kind of ["images", "video", "reel"] as const) expect(checkMedia(kind, 1)).toBeNull();
  });

  it("text is required for text and link, optional with files (the callers pass `required`)", () => {
    expect(checkMessage("", { required: true })).toBe("Nhập nội dung bài viết.");
    expect(checkMessage("", { required: false })).toBeNull();
  });
});
