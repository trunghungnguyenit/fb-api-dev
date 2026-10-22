import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const createUploadTarget = vi.fn();
const statObject = vi.fn();
const readHead = vi.fn();
const removeObjects = vi.fn();
const metaGet = vi.fn();
const metaPost = vi.fn();
const metaDelete = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: vi.fn() }));
vi.mock("@/lib/media/storage", () => ({
  createUploadTarget: (...a: unknown[]) => createUploadTarget(...a), statObject: (...a: unknown[]) => statObject(...a),
  readHead: (...a: unknown[]) => readHead(...a), removeObjects: (...a: unknown[]) => removeObjects(...a),
  mediaPath: (u: string, id: string, name: string) => `${u}/${id}/${name}`
}));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaGet: (...a: unknown[]) => metaGet(...a), metaPost: (...a: unknown[]) => metaPost(...a), metaDelete: (...a: unknown[]) => metaDelete(...a)
}));

import { confirmUpload, issueUpload, resolveMedia } from "@/lib/media/service";
import { userDb } from "@/lib/db";
import { buildLimits } from "@/lib/media/limits";
import { editFacebookMessage, readFacebookPost } from "@/lib/facebook-posts";
import { isMetaUploadUrl, MetaApiError, reelUploadUrl } from "@/lib/meta/client";

const MB = 1024 * 1024;
const limits = buildLimits({});
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const media = () => fake.tables.post_media;
const seedFile = (over: Record<string, unknown> = {}) => {
  const row = {
    id: `m${media().length + 1}`, user_id: "u1", post_id: null, kind: "image", storage_path: "u1/m/x.jpg", file_name: "x.jpg", mime: "image/jpeg",
    size_bytes: MB, position: 0, state: "uploaded", ...over
  };
  media().push(row);
  return row;
};

beforeEach(() => {
  fake.reset();
  for (const m of [createUploadTarget, statObject, readHead, removeObjects, metaGet, metaPost, metaDelete]) m.mockReset();
  createUploadTarget.mockResolvedValue({ url: "https://storage.test/upload", token: "t" });
  removeObjects.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("uploading a video or a Reel", () => {
  it("records the kind and gives the file a matching extension", async () => {
    const video = await issueUpload("u1", { kind: "video", mime: "video/mp4", size: 30 * MB, name: "Clip đẹp.MP4" }, limits);
    expect(video).toMatchObject({ ok: true });
    expect(media()[0]).toMatchObject({ kind: "video", mime: "video/mp4", state: "pending" });
    expect(String(media()[0].storage_path)).toMatch(/\/Clip-dep\.mp4$/);

    const reel = await issueUpload("u1", { kind: "reel", mime: "video/quicktime", size: 10 * MB, name: "r.mov" }, limits);
    expect(reel).toMatchObject({ ok: true });
    expect(String(media()[1].storage_path)).toMatch(/\/r\.mov$/);
  });

  it("refuses wrong types and sizes for each kind, using that kind's limit", async () => {
    expect(await issueUpload("u1", { kind: "video", mime: "image/png", size: MB }, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TYPE_INVALID" } });
    expect(await issueUpload("u1", { kind: "image", mime: "video/mp4", size: MB }, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TYPE_INVALID" } });
    const big = await issueUpload("u1", { kind: "reel", mime: "video/mp4", size: 51 * MB }, limits);
    expect(big).toMatchObject({ ok: false, problem: { code: "MEDIA_TOO_LARGE", status: 413 } });
    expect(big.ok === false && big.problem.message).toBe("Mỗi Reels tối đa 50 MB.");
    expect(await issueUpload("u1", { kind: "reel", mime: "video/mp4", size: 51 * MB }, buildLimits({ MEDIA_MAX_FILE_MB: "500", MEDIA_MAX_REEL_MB: "100" }))).toMatchObject({ ok: true });
  });

  it("confirms by the real content: an MP4 passes, an image sent as a video does not", async () => {
    await issueUpload("u1", { kind: "video", mime: "video/mp4", size: 5 * MB }, limits);
    statObject.mockResolvedValue({ size: 5 * MB, mime: "video/mp4" });
    readHead.mockResolvedValue(MP4);
    expect(await confirmUpload("u1", String(media()[0].id), limits)).toMatchObject({ ok: true, media: { state: "uploaded", size_bytes: 5 * MB } });

    await issueUpload("u1", { kind: "video", mime: "video/mp4", size: 5 * MB }, limits);
    readHead.mockResolvedValue(JPEG);
    expect(await confirmUpload("u1", String(media()[1].id), limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TYPE_INVALID" } });
    expect(removeObjects).toHaveBeenCalled();
    expect(media()[1].state).toBe("failed");
  });
});

describe("a post's media: images, or one video / Reel", () => {
  const db = () => userDb("u1");

  it("accepts a single video or Reel and derives the post type", async () => {
    const v = seedFile({ kind: "video", mime: "video/mp4", size_bytes: 30 * MB });
    const r = seedFile({ kind: "reel", mime: "video/mp4", size_bytes: 30 * MB });
    expect(await resolveMedia(db(), [{ id: v.id }], { limits })).toMatchObject({ ok: true, value: { postType: "video" } });
    expect(await resolveMedia(db(), [{ id: r.id }], { limits })).toMatchObject({ ok: true, value: { postType: "reel" } });
  });

  it("refuses a mix, two videos, and a video with a link", async () => {
    const v = seedFile({ kind: "video", mime: "video/mp4" });
    const v2 = seedFile({ kind: "video", mime: "video/mp4" });
    const img = seedFile();
    const code = async (ids: string[], linkUrl?: string) => {
      const r = await resolveMedia(db(), ids.map((id) => ({ id })), { linkUrl, limits });
      return r.ok ? "ok" : r.problem.code;
    };
    expect(await code([v.id, img.id])).toBe("MEDIA_MIXED");
    expect(await code([v.id, v2.id])).toBe("MEDIA_MIXED");
    expect(await code([v.id], "https://x.test")).toBe("MEDIA_WITH_LINK");
  });

  it("accepts a stored video that fits the video limit", async () => {
    const v = seedFile({ kind: "video", mime: "video/mp4", size_bytes: 40 * MB });
    expect(await resolveMedia(db(), [{ id: v.id }], { limits })).toMatchObject({ ok: true });
  });
});

describe("Facebook's upload hosts", () => {
  it("only Facebook's own https hosts may receive the token", () => {
    expect(isMetaUploadUrl("https://rupload.facebook.com/video-upload/v26.0/1")).toBe(true);
    expect(isMetaUploadUrl("https://facebook.com/x")).toBe(true);
    for (const bad of ["http://rupload.facebook.com/x", "https://evil.example/x", "https://facebook.com.evil.example/x", "https://notfacebook.com/x", "javascript:alert(1)", "not a url"]) {
      expect(isMetaUploadUrl(bad)).toBe(false);
    }
    expect(reelUploadUrl("123")).toBe("https://rupload.facebook.com/video-upload/v26.0/123");
  });
});

describe("a published video on Facebook (stats, edit)", () => {
  const ref = { id: "post1", page_id: "pageRow1", facebook_post_id: "vid-1", post_type: "video" };
  beforeEach(() => {
    fake.tables.facebook_pages.push({ id: "pageRow1", user_id: "u1", page_access_token_encrypted: "enc", is_active: true, removed_at: null });
  });

  it("reads a video's description and link (a relative permalink becomes a full one) and its engagement", async () => {
    metaGet.mockImplementation(async (_id: string, _t: string, params: { fields: string }) =>
      params.fields.startsWith("description") ? { description: "Mô tả", permalink_url: "/page/videos/1/" }
        : { reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } } });
    expect(await readFacebookPost("u1", ref)).toEqual({
      permalinkUrl: "https://www.facebook.com/page/videos/1/", message: "Mô tả", reactions: 7, comments: 2, shares: null
    });
    expect(metaGet.mock.calls[0][2]).toEqual({ fields: "description,permalink_url" });
  });

  it("still returns the video when Facebook refuses the engagement fields on a Video node", async () => {
    metaGet.mockImplementation(async (_id: string, _t: string, params: { fields: string }) => {
      if (params.fields.startsWith("description")) return { description: "Mô tả", permalink_url: "https://facebook.com/v/1" };
      throw new MetaApiError("(#100) field not supported", "100", 400);
    });
    expect(await readFacebookPost("u1", ref)).toMatchObject({ message: "Mô tả", reactions: null, comments: null, shares: null });
  });

  it("text posts keep reading `message` and the share count", async () => {
    metaGet.mockResolvedValue({ message: "chữ", permalink_url: "https://facebook.com/p/1", reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } }, shares: { count: 3 } });
    expect(await readFacebookPost("u1", { ...ref, post_type: "text" })).toMatchObject({ message: "chữ", shares: 3 });
  });

  it("edits a video's description, and a text post's message", async () => {
    metaPost.mockResolvedValue({ success: true });
    await editFacebookMessage("u1", ref, "Mô tả mới");
    expect(metaPost).toHaveBeenLastCalledWith("vid-1", "token-of-enc", { description: "Mô tả mới" });
    await editFacebookMessage("u1", { ...ref, post_type: "text" }, "Chữ mới");
    expect(metaPost).toHaveBeenLastCalledWith("vid-1", "token-of-enc", { message: "Chữ mới" });
  });
});
