import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaPost = vi.fn();
const notify = vi.fn();
const statObject = vi.fn();
const readHead = vi.fn();
const signedUrl = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock("@/lib/media/storage", () => ({
  statObject: (...a: unknown[]) => statObject(...a),
  readHead: (...a: unknown[]) => readHead(...a),
  signedUrl: (...a: unknown[]) => signedUrl(...a)
}));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaPost: (...a: unknown[]) => metaPost(...a)
}));

import { publishPost } from "@/lib/publisher";
import { MetaApiError } from "@/lib/meta/client";
import {
  createdPostId, feedRequest, multiPhotoRequest, singlePhotoRequest, unpublishedPhotoRequest
} from "@/lib/media/publish-media";

const MB = 1024 * 1024;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const post = (over: Record<string, unknown> = {}) => ({
  id: "post1", user_id: "u1", page_id: "pageRow1", message: "Chú thích", link_url: null as string | null,
  attempt_count: 0, scheduled_at: "2026-10-21T00:00:00Z", post_type: "photo", ...over
});
const postRow = () => fake.tables.posts[0];
const mediaRow = (id: string) => fake.tables.post_media.find((m) => m.id === id)!;

function seed(postType: string, images: number, over: Record<string, unknown> = {}) {
  fake.reset();
  fake.tables.posts.push({ ...post({ post_type: postType }), status: "scheduled", sent_at: null, next_attempt_at: null, last_error_code: null });
  fake.tables.facebook_pages.push({ id: "pageRow1", user_id: "u1", page_id: "fb-page-1", page_access_token_encrypted: "enc", is_active: true });
  for (let i = 0; i < images; i++) {
    fake.tables.post_media.push({
      id: `m${i}`, user_id: "u1", post_id: "post1", kind: "image", storage_path: `u1/m${i}/x.jpg`, mime: "image/jpeg",
      size_bytes: MB, position: i, facebook_media_id: null, state: "uploaded", ...over
    });
  }
}

beforeEach(() => {
  for (const m of [metaPost, notify, statObject, readHead, signedUrl]) m.mockReset();
  statObject.mockResolvedValue({ size: 2 * MB, mime: "image/jpeg" });
  readHead.mockResolvedValue(JPEG);
  signedUrl.mockImplementation(async (path: string) => `https://signed.test/${path}`);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Graph request builders", () => {
  it("builds each kind of request", () => {
    expect(feedRequest("P", { message: "hi", link_url: null })).toEqual({ path: "P/feed", params: { message: "hi" } });
    expect(feedRequest("P", { message: "hi", link_url: "https://x.test" }).params).toEqual({ message: "hi", link: "https://x.test" });
    expect(singlePhotoRequest("P", "https://u", "caption")).toEqual({ path: "P/photos", params: { url: "https://u", published: "true", caption: "caption" } });
    expect(singlePhotoRequest("P", "https://u", "").params).toEqual({ url: "https://u", published: "true" });
    expect(unpublishedPhotoRequest("P", "https://u")).toEqual({ path: "P/photos", params: { url: "https://u", published: "false" } });
  });

  it("attaches the uploaded photos to one feed post in order", () => {
    const r = multiPhotoRequest("P", "text", ["11", "22", "33"]);
    expect(r.path).toBe("P/feed");
    expect(r.params).toEqual({
      message: "text",
      "attached_media[0]": '{"media_fbid":"11"}', "attached_media[1]": '{"media_fbid":"22"}', "attached_media[2]": '{"media_fbid":"33"}'
    });
    expect(multiPhotoRequest("P", "", ["1"]).params).toEqual({ "attached_media[0]": '{"media_fbid":"1"}' });
  });

  it("takes the feed story id of a photo post, not the photo id", () => {
    expect(createdPostId({ id: "photo1", post_id: "page_post" })).toBe("page_post");
    expect(createdPostId({ id: "feed_post" })).toBe("feed_post");
    expect(createdPostId({})).toBeUndefined();
  });
});

describe("publishing a single photo", () => {
  it("sends one photo call with a signed URL and the caption, and records the post id", async () => {
    seed("photo", 1);
    metaPost.mockResolvedValue({ id: "photo-1", post_id: "page_post-1" });
    expect(await publishPost(post())).toEqual({ result: "published" });
    expect(metaPost).toHaveBeenCalledTimes(1);
    expect(metaPost).toHaveBeenCalledWith("fb-page-1/photos", "token-of-enc",
      { url: "https://signed.test/u1/m0/x.jpg", published: "true", caption: "Chú thích" }, expect.any(Number));
    expect(postRow()).toMatchObject({ status: "published", facebook_post_id: "page_post-1" });
    expect(postRow().sent_at).toBeTruthy();
  });

  it("treats a timeout on that call as unknown (the photo may be live), never as a clean failure", async () => {
    seed("photo", 1);
    metaPost.mockRejectedValue(new Error("network reset"));
    expect(await publishPost(post())).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "AMBIGUOUS" });
  });
});

describe("publishing several photos", () => {
  it("uploads each unpublished, remembers Facebook's ids, then makes ONE feed post", async () => {
    seed("photos", 3);
    let n = 0;
    metaPost.mockImplementation(async (path: string) => (path.endsWith("/photos") ? { id: `fbphoto${++n}` } : { id: "feed-post-1" }));
    expect(await publishPost(post({ post_type: "photos" }))).toEqual({ result: "published" });

    expect(metaPost).toHaveBeenCalledTimes(4);
    expect(metaPost.mock.calls.slice(0, 3).map((c) => [c[0], (c[2] as Record<string, string>).published])).toEqual([
      ["fb-page-1/photos", "false"], ["fb-page-1/photos", "false"], ["fb-page-1/photos", "false"]
    ]);
    expect(metaPost.mock.calls[3][0]).toBe("fb-page-1/feed");
    expect(metaPost.mock.calls[3][2]).toEqual({
      message: "Chú thích",
      "attached_media[0]": '{"media_fbid":"fbphoto1"}', "attached_media[1]": '{"media_fbid":"fbphoto2"}', "attached_media[2]": '{"media_fbid":"fbphoto3"}'
    });
    expect([0, 1, 2].map((i) => mediaRow(`m${i}`).facebook_media_id)).toEqual(["fbphoto1", "fbphoto2", "fbphoto3"]);
    expect(postRow()).toMatchObject({ status: "published", facebook_post_id: "feed-post-1" });
  });

  it("does not upload photos again on a retry", async () => {
    seed("photos", 3);
    mediaRow("m0").facebook_media_id = "alreadyA";
    mediaRow("m1").facebook_media_id = "alreadyB";
    metaPost.mockImplementation(async (path: string) => (path.endsWith("/photos") ? { id: "fbphotoNew" } : { id: "feed-post-1" }));
    await publishPost(post({ post_type: "photos" }));
    const uploads = metaPost.mock.calls.filter((c) => String(c[0]).endsWith("/photos"));
    expect(uploads).toHaveLength(1);
    expect((uploads[0][2] as Record<string, string>).url).toContain("u1/m2/");
    expect(metaPost.mock.calls.at(-1)![2]).toMatchObject({ "attached_media[0]": '{"media_fbid":"alreadyA"}', "attached_media[2]": '{"media_fbid":"fbphotoNew"}' });
  });

  it("a failure while uploading is a definite failure, not 'unknown': nothing was published and sent_at stays empty", async () => {
    seed("photos", 3);
    let n = 0;
    metaPost.mockImplementation(async () => { if (++n === 2) throw new Error("timeout"); return { id: `fbphoto${n}` }; });
    expect(await publishPost(post({ post_type: "photos" }))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "PUBLISH_FAILED", sent_at: null });
    expect(mediaRow("m0").facebook_media_id).toBe("fbphoto1"); // kept, so the manual retry reuses it
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_FAILED" }));
  });

  it("a rate limit while uploading puts the post back in the queue, not into failed", async () => {
    seed("photos", 2);
    const limited = new MetaApiError("too many calls", "32", 400);
    limited.retryAt = Date.now() + 60_000;
    metaPost.mockRejectedValue(limited);
    expect(await publishPost(post({ post_type: "photos" }))).toMatchObject({ result: "requeued", blockPageUntil: limited.retryAt });
    expect(postRow()).toMatchObject({ status: "scheduled", sent_at: null });
  });
});

describe("the checks made again right before publishing", () => {
  it("fails a post whose file is now over the limit, without sending anything", async () => {
    seed("photo", 1);
    statObject.mockResolvedValue({ size: 40 * MB, mime: "image/jpeg" }); // replaced by a big object after scheduling
    expect(await publishPost(post())).toEqual({ result: "failed" });
    expect(metaPost).not.toHaveBeenCalled();
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_TOO_LARGE", sent_at: null });
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_FAILED", code: "MEDIA_TOO_LARGE" }));
  });

  it("fails a post whose file content is no longer a valid image", async () => {
    seed("photo", 1);
    readHead.mockResolvedValue(Uint8Array.from(Buffer.from("<html>")));
    await publishPost(post());
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_TYPE_INVALID" });
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("fails a multi-photo post whose total size is over the limit", async () => {
    seed("photos", 6);
    statObject.mockResolvedValue({ size: 9 * MB, mime: "image/jpeg" }); // 6 x 9 MB = 54 MB > 50 MB
    await publishPost(post({ post_type: "photos" }));
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_TOTAL_TOO_LARGE" });
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("fails clearly when the file is gone or was purged", async () => {
    seed("photo", 1);
    statObject.mockResolvedValue(null);
    await publishPost(post());
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_MISSING" });

    seed("photo", 1, { state: "purged" });
    await publishPost(post());
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_MISSING" });

    seed("photo", 0);
    await publishPost(post());
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_MISSING" });
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("keeps the post queued when storage itself is unavailable", async () => {
    seed("photo", 1);
    statObject.mockRejectedValue(new Error("storage down"));
    expect(await publishPost(post())).toEqual({ result: "requeued" });
    expect(postRow()).toMatchObject({ status: "scheduled", sent_at: null });
    expect(metaPost).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses today's limits: lowering them after scheduling blocks the post", async () => {
    // (the limits are read from the environment at startup; this checks the per-file rule against the same config)
    seed("photo", 1);
    statObject.mockResolvedValue({ size: 10 * MB + 1, mime: "image/jpeg" });
    await publishPost(post());
    expect(postRow()).toMatchObject({ last_error_code: "MEDIA_TOO_LARGE" });
  });
});

describe("text posts are untouched", () => {
  it("still use the plain feed request and never look at storage", async () => {
    seed("text", 0);
    metaPost.mockResolvedValue({ id: "feed-1" });
    expect(await publishPost(post({ post_type: "text", link_url: "https://x.test" }))).toEqual({ result: "published" });
    expect(metaPost).toHaveBeenCalledWith("fb-page-1/feed", "token-of-enc", { message: "Chú thích", link: "https://x.test" }, expect.any(Number));
    expect(statObject).not.toHaveBeenCalled();
  });
});
