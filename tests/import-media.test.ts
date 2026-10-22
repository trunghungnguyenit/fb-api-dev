import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const removeObjects = vi.fn().mockResolvedValue(undefined);
let failApplyOn = 0; // the n-th applyMedia call fails (0 = never)
let applyCalls = 0;
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/media/storage", () => ({
  createUploadTarget: vi.fn(), statObject: vi.fn(), readHead: vi.fn(), removeObjects: (...a: unknown[]) => removeObjects(...a),
  mediaPath: (u: string, id: string, name: string) => `${u}/${id}/${name}`
}));
vi.mock("@/lib/media/service", async (original) => {
  const real = await original<typeof import("@/lib/media/service")>();
  return { ...real, applyMedia: (...a: Parameters<typeof real.applyMedia>) => (++applyCalls === failApplyOn ? Promise.reject(new Error("attach failed")) : real.applyMedia(...a)) };
});

import { cellToString, rowsFromJson, rowsFromMatrix, type RawRow } from "@/lib/import/columns";
import { createImportedPosts, ImportProblem } from "@/lib/import/commit";
import { fileKey, parseTypeCell, splitFileNames, type DeclaredFile } from "@/lib/import/files";
import { summarize, validateImportRows, type PageRef, type ValidateOptions } from "@/lib/import/validate";
import { userDb } from "@/lib/db";
import { buildLimits } from "@/lib/media/limits";

const MB = 1024 * 1024;
const NOW = Date.parse("2026-10-20T02:00:00.000Z");
const limits = buildLimits({});
const pages: PageRef[] = [{ id: "p1", page_name: "HTStudio", page_id: "1001" }];

const file = (name: string, mime: string, size = 1 * MB): DeclaredFile => ({ name, mime, size });
const picked = (...files: DeclaredFile[]) => new Map(files.map((f) => [fileKey(f.name), f]));
const FILES = picked(
  file("a.jpg", "image/jpeg"), file("b.PNG", "image/png"), file("c.gif", "image/gif"),
  file("v.mp4", "video/mp4", 20 * MB), file("w.mov", "video/quicktime", 20 * MB), file("doc.pdf", "application/pdf")
);
const opts = (over: Partial<ValidateOptions> = {}): ValidateOptions => ({
  pages, defaultPageId: "p1", nowMs: NOW, existing: new Set(), spread: null, includeDuplicates: false, files: FILES, limits, ...over
});
const row = (line: number, over: Partial<RawRow> = {}): RawRow =>
  ({ line, message: "Bài", link: "", time: "", fanpage: "", note: "", type: "", files: "", ...over });
const one = (over: Partial<RawRow>, o: Partial<ValidateOptions> = {}) => validateImportRows([row(2, over)], opts(o))[0];

describe("file columns", () => {
  it("reads the new columns by Vietnamese or English headers, and a file column alone is enough", () => {
    const r = rowsFromMatrix([["Nội dung", "Loại bài", "Tệp đính kèm"], ["Xin chào", "reel", "v.mp4"]]);
    expect(r).toMatchObject({ ok: true, rows: [{ message: "Xin chào", type: "reel", files: "v.mp4" }] });
    expect(rowsFromMatrix([["Files"], ["a.jpg;b.png"]])).toMatchObject({ ok: true, rows: [{ message: "", files: "a.jpg;b.png" }] });
    expect(rowsFromMatrix([["Liên kết"], ["https://a.vn"]])).toEqual({ ok: false, reason: "no_message_column" });
  });

  it("takes a list of names from JSON", () => {
    expect(rowsFromJson([{ message: "x", type: "photos", files: ["a.jpg", "b.png"] }])).toMatchObject({ ok: true, rows: [{ files: "a.jpg;b.png", type: "photos" }] });
    expect(cellToString(["a"] as unknown as string)).toBe("a");
  });

  it("splits names on ; | and new lines, keeps commas inside a name, and matches regardless of case", () => {
    expect(splitFileNames("a.jpg; b, c.png |d.gif\n e.mp4;;")).toEqual(["a.jpg", "b, c.png", "d.gif", "e.mp4"]);
    expect(fileKey("  Ảnh Đẹp.JPG ")).toBe(fileKey("ảnh đẹp.jpg"));
  });

  it("understands the words of the type column, empty and unknown", () => {
    expect(parseTypeCell("Reels")).toBe("reel");
    expect(parseTypeCell("Nhiều ảnh")).toBe("photos");
    expect(parseTypeCell("Bài viết")).toBe("text");
    expect(parseTypeCell("  ")).toBe("");
    expect(parseTypeCell("story")).toBeNull();
  });
});

describe("validateImportRows with files", () => {
  it("derives the post type from the files: 1 photo, several photos, video, and Reels only when the type column says so", () => {
    expect(one({ files: "a.jpg" })).toMatchObject({ willImport: true, postType: "photo", mediaKind: "image", fileKeys: ["a.jpg"] });
    expect(one({ files: "a.jpg; b.png; c.gif" })).toMatchObject({ willImport: true, postType: "photos", mediaKind: "image" });
    expect(one({ files: "v.mp4" })).toMatchObject({ willImport: true, postType: "video", mediaKind: "video" });
    expect(one({ files: "w.mov", type: "reel" })).toMatchObject({ willImport: true, postType: "reel", mediaKind: "reel" });
    expect(one({ message: "x" })).toMatchObject({ postType: "text", mediaKind: null });
    expect(one({ message: "x", link: "https://a.vn" })).toMatchObject({ postType: "link" });
  });

  it("finds files by name regardless of case, and a photo or video needs no caption", () => {
    expect(one({ message: "", files: "B.png" })).toMatchObject({ willImport: true, postType: "photo", message: "" });
    expect(one({ message: "" }).errors[0].code).toBe("MESSAGE_EMPTY");
  });

  it("refuses a file that was not picked, a repeated file, a link with files, and files that are not media", () => {
    expect(one({ files: "missing.jpg" }).errors[0]).toMatchObject({ code: "FILE_MISSING" });
    expect(one({ files: "a.jpg; A.JPG" }).errors[0].code).toBe("FILE_REPEATED");
    expect(one({ files: "a.jpg", link: "https://a.vn" }).errors[0].code).toBe("MEDIA_WITH_LINK");
    expect(one({ files: "doc.pdf" }).errors[0].code).toBe("FILE_INVALID");
  });

  it("refuses a mix of photos and a video, and more than one video", () => {
    expect(one({ files: "a.jpg; v.mp4" }).errors[0].code).toBe("MEDIA_MIXED");
    expect(one({ files: "v.mp4; w.mov" }).errors[0].code).toBe("MEDIA_MIXED");
  });

  it("checks the type column against the files", () => {
    expect(one({ files: "a.jpg", type: "reel" }).errors[0].code).toBe("TYPE_MISMATCH");
    expect(one({ files: "v.mp4", type: "ảnh" }).errors[0].code).toBe("TYPE_MISMATCH");
    expect(one({ files: "a.jpg; b.png", type: "ảnh" }).errors[0].code).toBe("TYPE_MISMATCH"); // two photos are "nhiều ảnh"
    expect(one({ message: "x", type: "video" }).errors[0].code).toBe("TYPE_MISMATCH"); // no file
    expect(one({ files: "a.jpg", type: "story" }).errors[0].code).toBe("TYPE_INVALID");
    expect(one({ message: "x", type: "bài viết" }).willImport).toBe(true);
    expect(one({ files: "v.mp4", type: "video" }).willImport).toBe(true);
  });

  it("checks the type column against the link cell too", () => {
    expect(one({ message: "x", type: "liên kết" }).errors[0].code).toBe("TYPE_MISMATCH");
    expect(one({ message: "x", link: "https://a.vn", type: "bài viết" }).errors[0].code).toBe("TYPE_MISMATCH");
    expect(one({ message: "x", link: "https://a.vn", type: "liên kết" }).willImport).toBe(true);
  });

  it("does not call a row a duplicate of one that was dropped for the upload caps", () => {
    const one1 = buildLimits({ MEDIA_IMPORT_MAX_FILES: "1" });
    const r = validateImportRows([row(2, { files: "a.jpg", message: "Một" }), row(3, { files: "b.png", message: "Hai" }), row(4, { files: "b.png", message: "Hai" })], opts({ limits: one1 }));
    expect(r.map((x) => x.errors[0]?.code ?? (x.duplicate ? "dup" : "ok"))).toEqual(["ok", "MEDIA_BUDGET", "MEDIA_BUDGET"]);
  });

  it("applies the configured limits per file and per post", () => {
    const big = picked(file("big.jpg", "image/jpeg", 11 * MB), file("hd.mp4", "video/mp4", 51 * MB));
    expect(one({ files: "big.jpg" }, { files: big }).errors[0]).toMatchObject({ code: "FILE_INVALID", message: expect.stringContaining("10 MB") });
    expect(one({ files: "hd.mp4" }, { files: big }).errors[0].code).toBe("FILE_INVALID");
    const many = picked(...Array.from({ length: 11 }, (_, i) => file(`i${i}.jpg`, "image/jpeg")));
    expect(one({ files: [...many.values()].map((f) => f.name).join(";") }, { files: many }).errors[0].message).toContain("tối đa 10 ảnh");
    expect(one({ files: "big.jpg" }, { files: big, limits: buildLimits({ MEDIA_MAX_IMAGE_MB: "20" }) }).willImport).toBe(true);
  });

  it("lets rows share a file, but not as a video in one row and a Reel in another", () => {
    const [a, b] = validateImportRows([row(2, { files: "a.jpg" }), row(3, { files: "a.jpg; b.png", message: "Khác" })], opts());
    expect([a.willImport, b.willImport]).toEqual([true, true]);
    const [v, r] = validateImportRows([row(2, { files: "v.mp4" }), row(3, { files: "v.mp4", type: "reel", message: "Khác" })], opts());
    expect(v.willImport).toBe(true);
    expect(r.errors[0].code).toBe("FILE_KIND_CONFLICT");
  });

  it("caps one import by number of different files and by their total size, counting a shared file once", () => {
    const two = buildLimits({ MEDIA_IMPORT_MAX_FILES: "2" });
    const r = validateImportRows([row(2, { files: "a.jpg" }), row(3, { files: "a.jpg", message: "Lại" }), row(4, { files: "b.png" }), row(5, { files: "c.gif" })], opts({ limits: two }));
    expect(r.map((x) => x.willImport)).toEqual([true, true, true, false]);
    expect(r[3].errors[0]).toMatchObject({ code: "MEDIA_BUDGET", message: expect.stringContaining("2 tệp") });

    const small = buildLimits({ MEDIA_IMPORT_MAX_TOTAL_MB: "30" });
    const s = validateImportRows([row(2, { files: "v.mp4" }), row(3, { files: "w.mov", message: "Hai" })], opts({ limits: small }));
    expect(s.map((x) => x.willImport)).toEqual([true, false]);
    expect(s[1].errors[0].message).toContain("30 MB");
  });

  it("does not spend the upload budget on rows that will be skipped", () => {
    const two = buildLimits({ MEDIA_IMPORT_MAX_FILES: "1" });
    const r = validateImportRows([row(2, { files: "a.jpg" }), row(3, { files: "a.jpg" }), row(4, { files: "b.png", message: "Khác", time: "19/10/2026 08:00" })], opts({ limits: two }));
    expect(r[1].duplicate).toEqual({ kind: "file", line: 2 }); // same caption and same file
    expect(r[1].willImport).toBe(false);
    expect(r[2].errors.map((e) => e.code)).toEqual(["TIME_PAST"]); // not charged for the budget either
  });

  it("treats rows with the same caption but other files as different posts", () => {
    const r = validateImportRows([row(2, { files: "a.jpg" }), row(3, { files: "b.png" }), row(4, { message: "Bài" })], opts());
    expect(r.every((x) => x.willImport && !x.duplicate)).toBe(true);
  });

  it("summarises the rows that will be imported", () => {
    const r = validateImportRows([
      row(2, { files: "a.jpg" }), row(3, { files: "a.jpg; b.png", message: "Hai" }), row(4, { files: "w.mov", type: "reel", message: "Ba" }),
      row(5, { message: "Chỉ chữ" }), row(6, { files: "missing.jpg", message: "Lỗi" })
    ], opts());
    expect(summarize(r)).toMatchObject({ total: 5, willImport: 4, errors: 1, withMedia: 3 });
  });
});

describe("createImportedPosts", () => {
  const db = userDb("u1");
  const media = () => fake.tables.post_media;
  const posts = () => fake.tables.posts;

  function seed(id: string, over: Record<string, unknown> = {}) {
    media().push({
      id, user_id: "u1", post_id: null, kind: "image", storage_path: `u1/${id}/x.jpg`, file_name: `${id}.jpg`, mime: "image/jpeg",
      size_bytes: 1 * MB, position: 0, state: "uploaded", created_at: "2026-10-20T00:00:00Z", ...over
    });
  }
  const make = (rows: RawRow[]) => validateImportRows(rows, opts({ spread: null })).filter((r) => r.willImport);
  const uploadedAs = (...pairs: [string, string][]) => new Map(pairs.map(([name, id]) => [fileKey(name), id]));

  beforeEach(() => {
    fake.reset();
    failApplyOn = 0; applyCalls = 0; removeObjects.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.tables.import_batches.push({ id: "b1", user_id: "u1" });
  });

  it("creates text posts with their final status and media posts as drafts that are scheduled after their files are attached", async () => {
    seed("m1"); seed("m2", { mime: "image/png" }); seed("m3", { kind: "reel", mime: "video/quicktime", size_bytes: 20 * MB });
    const rows = make([
      row(2, { message: "Chữ có giờ", time: "21/10/2026 08:00" }),
      row(3, { message: "Chữ nháp" }),
      row(4, { files: "a.jpg; b.png", time: "21/10/2026 09:00", message: "Hai ảnh" }),
      row(5, { files: "w.mov", type: "reel", message: "Reel" })
    ]);
    await createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"], ["b.png", "m2"], ["w.mov", "m3"]), limits);

    const byMessage = (m: string) => posts().find((p) => p.message === m)!;
    expect(byMessage("Chữ có giờ")).toMatchObject({ status: "scheduled", post_type: "text", import_batch_id: "b1" });
    expect(byMessage("Chữ nháp")).toMatchObject({ status: "draft", scheduled_at: null });
    expect(byMessage("Hai ảnh")).toMatchObject({ status: "scheduled", post_type: "photos", scheduled_at: "2026-10-21T02:00:00.000Z" });
    expect(byMessage("Reel")).toMatchObject({ status: "draft", post_type: "reel" });
    expect(media().filter((m) => m.post_id === byMessage("Hai ảnh").id).map((m) => [m.id, m.position])).toEqual([["m1", 0], ["m2", 1]]);
    expect(media().find((m) => m.id === "m3")!.post_id).toBe(byMessage("Reel").id);
  });

  it("uploads a file once and copies it for the other posts that use it", async () => {
    seed("m1");
    const rows = make([row(2, { files: "a.jpg", message: "Một" }), row(3, { files: "a.jpg", message: "Hai" })]);
    await createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"]), limits);
    const first = posts().find((p) => p.message === "Một")!;
    const second = posts().find((p) => p.message === "Hai")!;
    expect(media()).toHaveLength(2);
    expect(media().find((m) => m.id === "m1")!.post_id).toBe(first.id);
    expect(media().find((m) => m.post_id === second.id)).toMatchObject({ storage_path: "u1/m1/x.jpg", state: "uploaded" });
  });

  it("refuses before creating anything when a file was not uploaded, is not as claimed, or is already on a post", async () => {
    const rows = make([row(2, { files: "a.jpg", message: "Ảnh" })]);
    await expect(createImportedPosts(db, "u1", "b1", rows, new Map(), limits)).rejects.toMatchObject({ problem: { code: "IMPORT_MEDIA_NOT_UPLOADED" } });
    seed("m1", { state: "pending" });
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"]), limits)).rejects.toBeInstanceOf(ImportProblem);
    media().length = 0; seed("m1", { post_id: "other" });
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"]), limits)).rejects.toMatchObject({ problem: { code: "MEDIA_IN_USE" } });
    media().length = 0; seed("m1", { kind: "video", mime: "video/mp4" });
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"]), limits)).rejects.toMatchObject({ problem: { code: "MEDIA_MISMATCH" } });
    media().length = 0;
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "nobody"]), limits)).rejects.toMatchObject({ problem: { code: "MEDIA_NOT_FOUND" } });
    expect(posts()).toHaveLength(0);
  });

  it("uses the sizes Storage measured, not the browser's: files bigger than they claimed stop the import before any post exists", async () => {
    seed("m1", { size_bytes: 30 * MB }); seed("m2", { mime: "image/png", size_bytes: 30 * MB }); // 60 MB of photos in one post (limit 50)
    const rows = make([row(2, { message: "Chữ", time: "21/10/2026 08:00" }), row(3, { files: "a.jpg; b.png", message: "Ảnh" })]);
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"], ["b.png", "m2"]), limits))
      .rejects.toMatchObject({ problem: { code: "MEDIA_TOTAL_TOO_LARGE", message: expect.stringContaining("Dòng 3") } });
    expect(posts()).toHaveLength(0);
  });

  it("refuses two names that point at the same upload", async () => {
    seed("m1");
    const rows = make([row(2, { files: "a.jpg", message: "Một" }), row(3, { files: "b.PNG", message: "Hai" })]);
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"], ["b.png", "m1"]), limits)).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
  });

  it("keeps every post a draft until all the files are attached, and takes the whole batch back with its files when attaching fails", async () => {
    seed("m1"); seed("m2", { mime: "image/png" });
    const rows = make([
      row(2, { message: "Chữ có giờ", time: "21/10/2026 08:00" }), row(3, { files: "a.jpg", message: "Một", time: "21/10/2026 09:00" }),
      row(4, { files: "a.jpg", message: "Dùng lại" }), row(5, { files: "b.png", message: "Hai" })
    ]);
    failApplyOn = 3; // the third post to get files fails
    await expect(createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"], ["b.png", "m2"]), limits)).rejects.toThrow("attach failed");
    expect(posts()).toHaveLength(0);
    expect(fake.tables.import_batches).toHaveLength(0);
    expect(media()).toHaveLength(0); // the originals and the copy are gone, nothing counts against the unattached uploads
    expect(removeObjects).toHaveBeenCalled();
  });

  it("drops uploads the posts did not use", async () => {
    seed("m1"); seed("stray", { mime: "image/png" });
    const rows = make([row(2, { files: "a.jpg", message: "Một" })]);
    await createImportedPosts(db, "u1", "b1", rows, uploadedAs(["a.jpg", "m1"], ["old.png", "stray"]), limits);
    expect(media().map((m) => m.id)).toEqual(["m1"]);
  });
});
