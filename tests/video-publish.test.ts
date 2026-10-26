import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaPost = vi.fn();
const metaGet = vi.fn();
const metaUploadFromUrl = vi.fn();
const metaUploadBytes = vi.fn();
const metaPostVideoFile = vi.fn();
const notify = vi.fn();
const deactivatePage = vi.fn();
const statObject = vi.fn();
const readHead = vi.fn();
const signedUrl = vi.fn();
const downloadObject = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/notifications", () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock("@/lib/media/storage", () => ({
  statObject: (...a: unknown[]) => statObject(...a), readHead: (...a: unknown[]) => readHead(...a),
  signedUrl: (...a: unknown[]) => signedUrl(...a), downloadObject: (...a: unknown[]) => downloadObject(...a)
}));
vi.mock("@/lib/publish-state", async (original) => ({ ...(await original<typeof import("@/lib/publish-state")>()), sleep: async () => {} }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaPost: (...a: unknown[]) => metaPost(...a), metaGet: (...a: unknown[]) => metaGet(...a),
  metaUploadFromUrl: (...a: unknown[]) => metaUploadFromUrl(...a), metaUploadBytes: (...a: unknown[]) => metaUploadBytes(...a),
  metaPostVideoFile: (...a: unknown[]) => metaPostVideoFile(...a)
}));

import { publishPost, processDuePosts } from "@/lib/publisher";
import { resolveProcessingPosts, REELS_PER_DAY } from "@/lib/video-publish";
import { MetaApiError, MetaRateLimitedError } from "@/lib/meta/client";
import { MIN_SEND_MS, SAFETY_MS } from "@/lib/publish-state";

const MB = 1024 * 1024;
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
const VIDEO_ID = "vid-123";
const NOW = new Date("2026-10-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
// The Reels-per-day check reads the real clock, so its rows must be dated against the real clock too (NOW is fixed).
const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

const due = (type: "video" | "reel", over: Record<string, unknown> = {}) => ({
  id: "post1", user_id: "u1", page_id: "pageRow1", message: "Giới thiệu", link_url: null as string | null,
  attempt_count: 0, scheduled_at: "2026-10-21T00:00:00Z", post_type: type, facebook_video_id: null as string | null, ...over
});
const postRow = () => fake.tables.posts[0];

function seed(type: "video" | "reel", over: Record<string, unknown> = {}, media: Record<string, unknown> | null = {}) {
  fake.reset();
  fake.tables.posts.push({ ...due(type), status: "scheduled", sent_at: null, next_attempt_at: null, last_error_code: null, publish_phase: null, ...over });
  fake.tables.facebook_pages.push({ id: "pageRow1", user_id: "u1", page_id: "fb-page-1", page_access_token_encrypted: "enc", is_active: true });
  if (media) fake.tables.post_media.push({
    id: "m1", user_id: "u1", post_id: "post1", kind: type, storage_path: "u1/m1/clip.mp4", mime: "video/mp4", size_bytes: 20 * MB,
    position: 0, facebook_media_id: null, state: "uploaded", ...media
  });
}
const ready = { status: { video_status: "ready", publishing_phase: { status: "complete", publish_status: "published" } } };
const processing = { status: { video_status: "processing", uploading_phase: { status: "complete" } } };

beforeEach(() => {
  for (const m of [metaPost, metaGet, metaUploadFromUrl, metaUploadBytes, metaPostVideoFile, notify, deactivatePage, statObject, readHead, signedUrl, downloadObject]) m.mockReset();
  statObject.mockResolvedValue({ size: 20 * MB, mime: "video/mp4" });
  readHead.mockResolvedValue(MP4);
  signedUrl.mockImplementation(async (path: string) => `https://signed.test/${path}`);
  downloadObject.mockResolvedValue(new Uint8Array([1, 2, 3]));
  metaUploadFromUrl.mockResolvedValue({ success: true });
  metaUploadBytes.mockResolvedValue({ success: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("publishing a plain video", () => {
  it("hands Facebook a link, then finishes the post when Facebook says the video is ready", async () => {
    seed("video");
    metaPost.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue(ready);
    expect(await publishPost(due("video"))).toEqual({ result: "published" });
    expect(metaPost).toHaveBeenCalledWith("fb-page-1/videos", "token-of-enc",
      { file_url: "https://signed.test/u1/m1/clip.mp4", description: "Giới thiệu" }, expect.any(Number));
    expect(metaGet).toHaveBeenCalledWith(VIDEO_ID, "token-of-enc", { fields: "status" });
    expect(postRow()).toMatchObject({ status: "published", facebook_post_id: VIDEO_ID, publish_phase: null, last_error_code: null });
    expect(postRow().sent_at).toBeTruthy();
    expect(fake.tables.publish_attempts[0]).toMatchObject({ outcome: "success", facebook_post_id: VIDEO_ID });
  });

  it("when Facebook is still converting, the post stays 'publishing' with its video id and the run moves on", async () => {
    seed("video");
    metaPost.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue(processing);
    expect(await publishPost(due("video"))).toEqual({ result: "processing" });
    expect(postRow()).toMatchObject({ status: "publishing", publish_phase: "processing", facebook_video_id: VIDEO_ID, locked_at: null });
    expect(postRow().processing_since).toBeTruthy();
    expect(fake.tables.publish_attempts[0].outcome).toBe("started"); // closed later, when the outcome is known
    expect(notify).not.toHaveBeenCalled();
  });

  it("can send the bytes itself instead of a link (binary mode)", async () => {
    seed("video");
    metaPostVideoFile.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue(ready);
    const { runVideoPublish } = await import("@/lib/video-publish");
    const result = await runVideoPublish({
      post: due("video") as never, pageFbId: "fb-page-1", token: "tok", markSent: async () => {}, mode: "binary"
    });
    expect(result).toEqual({ result: "published", facebookPostId: VIDEO_ID });
    expect(metaPostVideoFile).toHaveBeenCalledWith("fb-page-1/videos", "tok", { description: "Giới thiệu" },
      expect.objectContaining({ type: "video/mp4", data: expect.any(Uint8Array) }), expect.any(Number));
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("in binary mode a failed download proves nothing was sent: the video is not called 'unknown'", async () => {
    seed("video", { status: "publishing" });
    downloadObject.mockRejectedValue(new Error("storage down"));
    const markSent = vi.fn();
    const { runVideoPublish } = await import("@/lib/video-publish");
    await expect(runVideoPublish({
      post: due("video") as never, pageFbId: "fb-page-1", token: "tok", markSent, mode: "binary"
    })).rejects.toThrow("storage down");
    expect(markSent).not.toHaveBeenCalled(); // so the publisher reports a clean failure, not AMBIGUOUS
    expect(metaPostVideoFile).not.toHaveBeenCalled();
  });

  it("reports Facebook's 'cannot fetch the file' as such, and a failure after the poll as a failed video", async () => {
    seed("video");
    metaPost.mockRejectedValue(new MetaApiError("cannot fetch", "389", 400));
    expect(await publishPost(due("video"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "FB_VIDEO_FETCH_FAILED" });

    seed("video");
    metaPost.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue({ status: { video_status: "error" } });
    expect(await publishPost(due("video"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "FB_VIDEO_FAILED", facebook_video_id: null, publish_phase: null });
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_FAILED", code: "FB_VIDEO_FAILED" }));
  });

  it("a timeout on the creating call is an unknown outcome, like a text post", async () => {
    seed("video");
    metaPost.mockRejectedValue(new Error("network reset"));
    expect(await publishPost(due("video"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "AMBIGUOUS" });
  });

  it("is re-checked before sending: a file now over the limit fails without calling Facebook", async () => {
    seed("video");
    statObject.mockResolvedValue({ size: 80 * MB, mime: "video/mp4" });
    expect(await publishPost(due("video"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "MEDIA_TOO_LARGE", sent_at: null });
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("is never published inline from a web request (publish now): it stays queued for the scheduler", async () => {
    seed("video");
    expect(await processDuePosts({ postId: "post1" })).toEqual([]);
    expect(metaPost).not.toHaveBeenCalled();
    expect(postRow().status).toBe("scheduled");
  });
});

describe("publishing a Reel", () => {
  it("starts a session, remembers it BEFORE uploading, uploads, marks sent, then finishes", async () => {
    seed("reel");
    const order: string[] = [];
    metaPost.mockImplementation(async (path: string, _t: string, params: Record<string, string>) => {
      if (params.upload_phase === "start") { order.push("start"); return { video_id: VIDEO_ID, upload_url: "https://rupload.facebook.com/video-upload/v26.0/vid-123" }; }
      order.push(`finish(sent_at ${postRow().sent_at ? "set" : "empty"})`);
      return { success: true };
    });
    metaUploadFromUrl.mockImplementation(async () => {
      order.push(`upload(phase ${postRow().publish_phase}, id ${postRow().facebook_video_id}, sent_at ${postRow().sent_at ? "set" : "empty"})`);
      return { success: true };
    });
    metaGet.mockResolvedValue(ready);

    expect(await publishPost(due("reel"))).toEqual({ result: "published" });
    expect(order).toEqual(["start", "upload(phase uploading, id vid-123, sent_at empty)", "finish(sent_at set)"]);
    expect(metaUploadFromUrl).toHaveBeenCalledWith("https://rupload.facebook.com/video-upload/v26.0/vid-123", "token-of-enc",
      "https://signed.test/u1/m1/clip.mp4", expect.any(Number));
    expect(metaPost).toHaveBeenLastCalledWith("fb-page-1/video_reels", "token-of-enc",
      { upload_phase: "finish", video_id: VIDEO_ID, video_state: "PUBLISHED", description: "Giới thiệu" }, expect.any(Number));
    expect(postRow()).toMatchObject({ status: "published", facebook_post_id: VIDEO_ID, publish_phase: null });
  });

  it("never sends the token to a host that is not Facebook's: it falls back to the documented address", async () => {
    seed("reel");
    metaPost.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) =>
      (params.upload_phase === "start" ? { video_id: VIDEO_ID, upload_url: "https://evil.example/steal" } : { success: true }));
    metaGet.mockResolvedValue(ready);
    await publishPost(due("reel"));
    expect(metaUploadFromUrl.mock.calls[0][0]).toBe("https://rupload.facebook.com/video-upload/v26.0/vid-123");
  });

  it("resumes an interrupted Reel instead of starting a second session, and skips an upload that already arrived", async () => {
    seed("reel", { facebook_video_id: VIDEO_ID, publish_phase: "uploading" });
    metaGet.mockImplementation(async () => processing); // file is there, Facebook is converting
    metaPost.mockResolvedValue({ success: true });
    await publishPost(due("reel", { facebook_video_id: VIDEO_ID }));
    expect(metaPost.mock.calls.some((c) => (c[2] as Record<string, string>).upload_phase === "start")).toBe(false);
    expect(metaUploadFromUrl).not.toHaveBeenCalled();
    expect(metaPost.mock.calls.some((c) => (c[2] as Record<string, string>).upload_phase === "finish")).toBe(true);
  });

  it("resumes by uploading again when the file never arrived", async () => {
    seed("reel", { facebook_video_id: VIDEO_ID, publish_phase: "uploading" });
    metaGet.mockResolvedValueOnce({ status: { video_status: "uploading", uploading_phase: { status: "in_progress" } } }).mockResolvedValue(ready);
    metaPost.mockResolvedValue({ success: true });
    expect(await publishPost(due("reel", { facebook_video_id: VIDEO_ID }))).toEqual({ result: "published" });
    expect(metaUploadFromUrl).toHaveBeenCalledTimes(1);
  });

  it("a resumed Reel that is already live is simply finished", async () => {
    seed("reel", { facebook_video_id: VIDEO_ID, publish_phase: "uploading" });
    metaGet.mockResolvedValue(ready);
    expect(await publishPost(due("reel", { facebook_video_id: VIDEO_ID }))).toEqual({ result: "published" });
    expect(metaUploadFromUrl).not.toHaveBeenCalled();
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("a timeout on the finish call is not 'unknown': the video id lets Facebook answer, so it goes on as processing", async () => {
    seed("reel");
    metaPost.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      if (params.upload_phase === "start") return { video_id: VIDEO_ID };
      throw new Error("network reset");
    });
    metaGet.mockResolvedValue(processing);
    expect(await publishPost(due("reel"))).toEqual({ result: "processing" });
    expect(postRow()).toMatchObject({ status: "publishing", publish_phase: "processing", facebook_video_id: VIDEO_ID });
  });

  it("a clean rejection of the finish call is a real failure, and the dead session is forgotten", async () => {
    seed("reel");
    metaPost.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      if (params.upload_phase === "start") return { video_id: VIDEO_ID };
      throw new MetaApiError("invalid video", "100", 400);
    });
    expect(await publishPost(due("reel"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", facebook_video_id: null, publish_phase: null });
  });

  it("a failed upload is a definite failure (nothing was published)", async () => {
    seed("reel");
    metaPost.mockResolvedValue({ video_id: VIDEO_ID });
    metaUploadFromUrl.mockRejectedValue(new MetaApiError("cannot fetch", "389", 400));
    expect(await publishPost(due("reel"))).toEqual({ result: "failed" });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "FB_VIDEO_FETCH_FAILED", sent_at: null });
  });

  it("waits when the Page already published 30 Reels in 24 hours, without starting a session", async () => {
    seed("reel");
    for (let i = 0; i < REELS_PER_DAY; i++) {
      fake.tables.posts.push({ id: `old${i}`, user_id: "u1", page_id: "pageRow1", post_type: "reel", status: "published", published_at: realAgo(2 * 3_600_000) });
    }
    // 30 published + this one (publishing) = 31 > 30
    metaPost.mockResolvedValue({ video_id: VIDEO_ID });
    const result = await publishPost(due("reel"));
    expect(result).toEqual({ result: "requeued" });
    expect(metaPost).not.toHaveBeenCalled();
    expect(postRow()).toMatchObject({ status: "scheduled", sent_at: null });
    expect(new Date(String(postRow().next_attempt_at)).getTime()).toBeGreaterThan(Date.now());
    expect(notify).not.toHaveBeenCalled();
  });

  it("is within the limit with fewer than 30, and older Reels do not count", async () => {
    seed("reel");
    for (let i = 0; i < 40; i++) fake.tables.posts.push({ id: `old${i}`, user_id: "u1", page_id: "pageRow1", post_type: "reel", status: "published", published_at: realAgo(30 * 3_600_000) });
    metaPost.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => (params.upload_phase === "start" ? { video_id: VIDEO_ID } : { success: true }));
    metaGet.mockResolvedValue(ready);
    expect(await publishPost(due("reel"))).toEqual({ result: "published" });
  });

  it("a rate limit while starting puts the Reel back in the queue", async () => {
    seed("reel");
    const limited = new MetaApiError("too many calls", "32", 400);
    limited.retryAt = Date.now() + 60_000;
    metaPost.mockRejectedValue(limited);
    expect(await publishPost(due("reel"))).toMatchObject({ result: "requeued", blockPageUntil: limited.retryAt });
    expect(postRow().status).toBe("scheduled");
    metaPost.mockRejectedValue(new MetaRateLimitedError(Date.now() + 1000));
    seed("reel");
    expect(await publishPost(due("reel"))).toMatchObject({ result: "requeued" });
  });
});

describe("the function time limit (deadline)", () => {
  // Written against the exported constants, so they hold whatever the limits are set to.
  const GATE = MIN_SEND_MS + 5_000; // below this much time left a post is not even claimed (publisher.ts)
  const NEED = Math.max(30_000, MIN_SEND_MS) + SAFETY_MS; // what a video needs before it is handed to Facebook
  const left = (ms: number) => Date.now() + ms;

  it("does not even claim a post when too little time is left", async () => {
    seed("video");
    expect(await publishPost(due("video"), { deadline: left(GATE - 10_000) })).toEqual({ result: "requeued" });
    expect(postRow()).toMatchObject({ status: "scheduled", attempt_count: 0, sent_at: null });
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("puts a video back in the queue, unsent, when the time left cannot cover the upload", async () => {
    seed("video");
    expect(await publishPost(due("video"), { deadline: left(NEED - 2_000) })).toEqual({ result: "requeued" });
    expect(metaPost).not.toHaveBeenCalled();
    expect(postRow()).toMatchObject({ status: "scheduled", attempt_count: 1, sent_at: null, locked_at: null }); // claimed, then given back
    expect(notify).not.toHaveBeenCalled(); // nothing failed: the next run does it
  });

  it("cuts the upload timeout to the time left instead of the full 120 s", async () => {
    seed("video");
    metaPost.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue(ready);
    const spare = 10_000;
    await publishPost(due("video"), { deadline: left(NEED + spare) });
    const timeout = metaPost.mock.calls[0][3] as number;
    expect(timeout).toBeLessThanOrEqual(NEED + spare - SAFETY_MS);
    expect(timeout).toBeGreaterThan(NEED + spare - SAFETY_MS - 2_000);
    expect(timeout).toBeLessThan(120_000);
  });

  it("without a deadline the full upload timeout is kept", async () => {
    seed("video");
    metaPost.mockResolvedValue({ id: VIDEO_ID });
    metaGet.mockResolvedValue(ready);
    await publishPost(due("video"));
    expect(metaPost.mock.calls[0][3]).toBe(120_000);
  });

  it("skips the inline look at the status when the upload used up the time (the follow-up job does it)", async () => {
    seed("video", { status: "publishing" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const total = NEED + 5_000;
      const deadline = Date.now() + total;
      // The upload takes so long that only 10 s remain afterwards: not enough for a pause plus a look.
      metaPost.mockImplementation(async () => { vi.setSystemTime(Date.now() + total - 10_000); return { id: VIDEO_ID }; });
      const { runVideoPublish } = await import("@/lib/video-publish");
      const result = await runVideoPublish({
        post: due("video") as never, pageFbId: "fb-page-1", token: "tok", markSent: async () => {}, deadline
      });
      expect(result).toEqual({ result: "processing" });
      expect(metaGet).not.toHaveBeenCalled();
      expect(postRow()).toMatchObject({ publish_phase: "processing", facebook_video_id: VIDEO_ID }); // remembered for the follow-up
    } finally { vi.useRealTimers(); }
  });

  it("a Reel with no time left to upload keeps its session and resumes next run", async () => {
    seed("reel");
    const startNeeds = 30_000 + SAFETY_MS;
    const uploadNeeds = MIN_SEND_MS + SAFETY_MS;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const total = Math.max(startNeeds, uploadNeeds) + 1_000; // enough to start the session...
      const deadline = Date.now() + total;
      // ...but the session call takes long enough that the upload no longer fits.
      metaPost.mockImplementation(async () => { vi.setSystemTime(Date.now() + total - uploadNeeds + 1_000); return { video_id: VIDEO_ID }; });
      expect(await publishPost(due("reel"), { deadline })).toEqual({ result: "requeued" });
    } finally { vi.useRealTimers(); }
    expect(metaUploadFromUrl).not.toHaveBeenCalled();
    expect(postRow()).toMatchObject({ status: "scheduled", publish_phase: "uploading", facebook_video_id: VIDEO_ID, sent_at: null });
  });
});

describe("the follow-up job (resolveProcessingPosts)", () => {
  it("stops looking at posts once its deadline has passed", async () => {
    fake.reset();
    fake.tables.posts.push({
      id: "post1", user_id: "u1", page_id: "pageRow1", post_type: "video", status: "publishing", publish_phase: "processing",
      facebook_video_id: VIDEO_ID, sent_at: ago(60_000), locked_at: null, processing_since: ago(60_000), phase_checked_at: null, attempt_count: 1
    });
    const stats = await resolveProcessingPosts({ now: NOW, deadline: Date.now() - 1 });
    expect(stats.checked).toBe(0);
    expect(metaGet).not.toHaveBeenCalled();
  });

  const seedProcessing = (over: Record<string, unknown> = {}) => seed("video", {
    status: "publishing", publish_phase: "processing", facebook_video_id: VIDEO_ID, sent_at: ago(60_000), locked_at: null,
    processing_since: ago(60_000), phase_checked_at: null, attempt_count: 1, ...over
  });
  const startedAttempt = () => fake.tables.publish_attempts.push({ id: "a1", post_id: "post1", user_id: "u1", attempt_number: 1, outcome: "started", started_at: ago(60_000) });

  it("publishes a post whose video is now ready, and closes its attempt", async () => {
    seedProcessing(); startedAttempt();
    metaGet.mockResolvedValue(ready);
    const stats = await resolveProcessingPosts({ now: NOW });
    expect(stats).toMatchObject({ checked: 1, published: 1 });
    expect(postRow()).toMatchObject({ status: "published", facebook_post_id: VIDEO_ID, publish_phase: null });
    expect(fake.tables.publish_attempts[0]).toMatchObject({ outcome: "success", facebook_post_id: VIDEO_ID });
  });

  it("fails a post whose video Facebook rejected, tells the user, and forgets the dead video", async () => {
    seedProcessing(); startedAttempt();
    metaGet.mockResolvedValue({ status: { video_status: "processing", processing_phase: { status: "error", error: { message: "bad codec" } } } });
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ failed: 1 });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "FB_VIDEO_FAILED", facebook_video_id: null, publish_phase: null });
    expect(fake.tables.publish_attempts[0]).toMatchObject({ outcome: "failure", error_code: "FB_VIDEO_FAILED" });
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_FAILED", code: "FB_VIDEO_FAILED", dedupeKey: "publish-failed:post1:1" }));
  });

  it("leaves a post that is still processing, and does not look at it again for a few seconds", async () => {
    seedProcessing();
    metaGet.mockResolvedValue(processing);
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ checked: 1, waiting: 1 });
    expect(postRow()).toMatchObject({ status: "publishing", publish_phase: "processing" });
    expect(postRow().phase_checked_at).toBeTruthy();

    metaGet.mockClear();
    postRow().phase_checked_at = ago(5_000);
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ checked: 0 });
    expect(metaGet).not.toHaveBeenCalled();
    postRow().phase_checked_at = ago(20_000);
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ checked: 1 });
  });

  it("after 2 hours of silence the outcome is reported as unknown (it may be live), never retried", async () => {
    seedProcessing({ processing_since: ago(3 * 3_600_000) }); startedAttempt();
    metaGet.mockResolvedValue(processing);
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ unknown: 1 });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "AMBIGUOUS", publish_phase: null });
    expect(fake.tables.publish_attempts[0].outcome).toBe("ambiguous");
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "PUBLISH_AMBIGUOUS" }));
  });

  it("does not guess when Facebook cannot be reached or rate limits us", async () => {
    seedProcessing();
    metaGet.mockRejectedValue(new MetaApiError("too many calls", "32", 400));
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ waiting: 1 });
    expect(postRow().status).toBe("publishing");

    seedProcessing();
    metaGet.mockRejectedValue(new Error("network down"));
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ waiting: 1 });
    expect(postRow().status).toBe("publishing");
  });

  it("switches the Page off when its token is dead, and keeps the post waiting", async () => {
    seedProcessing();
    metaGet.mockRejectedValue(new MetaApiError("token expired", "190", 401));
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ waiting: 1 });
    expect(deactivatePage).toHaveBeenCalledWith("u1", "pageRow1");
    expect(postRow().status).toBe("publishing");
  });

  it("fails a post whose video no longer exists on Facebook", async () => {
    seedProcessing(); startedAttempt();
    const gone = new MetaApiError("does not exist", "100", 400, { subcode: "33" });
    metaGet.mockRejectedValue(gone);
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ failed: 1 });
    expect(postRow()).toMatchObject({ status: "failed", last_error_code: "FB_VIDEO_FAILED" });
  });

  it("puts an abandoned Reel upload back in the queue when the file never arrived", async () => {
    seed("reel", { status: "publishing", publish_phase: "uploading", facebook_video_id: VIDEO_ID, sent_at: ago(20 * 60_000), locked_at: ago(15 * 60_000), phase_checked_at: null });
    metaGet.mockResolvedValue({ status: { video_status: "uploading", uploading_phase: { status: "in_progress" } } });
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ resumed: 1 });
    expect(postRow()).toMatchObject({ status: "scheduled", sent_at: null, publish_phase: "uploading", facebook_video_id: VIDEO_ID });
  });

  it("moves an abandoned Reel to processing when Facebook has it (the finish went through)", async () => {
    seed("reel", { status: "publishing", publish_phase: "uploading", facebook_video_id: VIDEO_ID, sent_at: ago(20 * 60_000), locked_at: ago(15 * 60_000) });
    metaGet.mockResolvedValue(processing);
    await resolveProcessingPosts({ now: NOW });
    expect(postRow()).toMatchObject({ status: "publishing", publish_phase: "processing" });
  });

  it("does not touch a Reel upload that a live run is still working on", async () => {
    seed("reel", { status: "publishing", publish_phase: "uploading", facebook_video_id: VIDEO_ID, sent_at: ago(60_000), locked_at: ago(30_000) });
    expect(await resolveProcessingPosts({ now: NOW })).toMatchObject({ waiting: 1 });
    expect(metaGet).not.toHaveBeenCalled();
    seed("reel", { status: "publishing", publish_phase: "uploading", facebook_video_id: VIDEO_ID, sent_at: null, locked_at: ago(30_000) });
    await resolveProcessingPosts({ now: NOW });
    expect(metaGet).not.toHaveBeenCalled();
  });
});

describe("the reaper (orphaned `publishing` posts) and videos", () => {
  const stale = (id: string, over: Record<string, unknown>) => fake.tables.posts.push({
    id, user_id: "u1", page_id: "pageRow1", status: "publishing", post_type: "video", message: "m", link_url: null, attempt_count: 1,
    scheduled_at: "2099-01-01T00:00:00Z", locked_at: new Date(Date.now() - 11 * 60_000).toISOString(), next_attempt_at: null, last_error_code: null, ...over
  });
  const byId = (id: string) => fake.tables.posts.find((p) => p.id === id)!;

  it("never calls a video in a phase 'unknown': Facebook can answer for it. Plain unknown posts still are.", async () => {
    fake.reset();
    fake.tables.facebook_pages.push({ id: "pageRow1", user_id: "u1", page_id: "fb-page-1", page_access_token_encrypted: "enc", is_active: true });
    metaGet.mockResolvedValue(processing);
    stale("in-phase", { sent_at: realAgo(20 * 60_000), publish_phase: "processing", facebook_video_id: VIDEO_ID, processing_since: realAgo(20 * 60_000) });
    stale("no-phase", { sent_at: realAgo(20 * 60_000), publish_phase: null });
    stale("never-sent-reel", { post_type: "reel", sent_at: null, publish_phase: "uploading", facebook_video_id: "vid-9" });

    const { runPublishCycle } = await import("@/lib/publisher");
    await runPublishCycle();

    expect(byId("in-phase")).toMatchObject({ status: "publishing", publish_phase: "processing" }); // left to the follow-up
    expect(byId("no-phase")).toMatchObject({ status: "failed", last_error_code: "AMBIGUOUS" }); // as before
    expect(byId("never-sent-reel")).toMatchObject({ status: "scheduled", publish_phase: "uploading", facebook_video_id: "vid-9" }); // resumable
  });
});
