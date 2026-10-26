import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const metaPost = vi.fn();
const metaDelete = vi.fn();
const deactivatePage = vi.fn();
const requireUser = vi.fn();
const isSameOrigin = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/auth", () => ({ requireUser: () => requireUser() }));
vi.mock("@/lib/csrf", () => ({ isSameOrigin: () => isSameOrigin() }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaGet: (...a: unknown[]) => metaGet(...a), metaPost: (...a: unknown[]) => metaPost(...a), metaDelete: (...a: unknown[]) => metaDelete(...a)
}));

import { GET as listRoute } from "@/app/api/posts/[id]/comments/route";
import { PATCH as patchRoute } from "@/app/api/comments/[commentId]/route";
import { MetaApiError } from "@/lib/meta/client";

const POST_ID = "22222222-2222-4222-8222-222222222222";
const FEED_ID = "33333333-3333-4333-8333-333333333333";
const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const FB_POST = "1171329916068581_122111511207403780";
const COMMENT = "122111511207403780_998877";
const ALL_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement"];

const json = (res: Response) => res.json();
const patch = (commentId: string, body: unknown) =>
  patchRoute(new NextRequest(`http://localhost/api/comments/${commentId}`, {
    method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" }
  }), { params: Promise.resolve({ commentId }) } as never);
const list = (id: string) => listRoute(new NextRequest(`http://localhost/api/posts/${id}/comments?kind=app`), { params: Promise.resolve({ id }) });

function seed(scopes: string[] = ALL_SCOPES) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes });
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_id: "fb-page-1", connection_id: CONNECTION, page_access_token_encrypted: "enc", is_active: true, removed_at: null });
  fake.tables.posts.push({ id: POST_ID, user_id: "u1", page_id: PAGE, status: "published", facebook_post_id: FB_POST, facebook_deleted_at: null });
  fake.tables.page_feed_posts.push({ id: FEED_ID, user_id: "u1", page_id: PAGE, facebook_post_id: FB_POST, missing_since: null, post_id: null });
}
const actions = () => fake.tables.comment_actions;

beforeEach(() => {
  metaGet.mockReset(); metaPost.mockReset(); metaDelete.mockReset(); deactivatePage.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  isSameOrigin.mockReturnValue(true);
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("liking a comment as the Fanpage", () => {
  it("likes and unlikes with the Page's token, and logs both without any text", async () => {
    metaPost.mockResolvedValue({ success: true });
    metaDelete.mockResolvedValue({ success: true });
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, liked: true })).status).toBe(200);
    expect(metaPost).toHaveBeenLastCalledWith(`${COMMENT}/likes`, "token-of-enc", {});
    const res = await patch(COMMENT, { kind: "app", postId: POST_ID, liked: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, liked: false });
    expect(metaDelete).toHaveBeenLastCalledWith(`${COMMENT}/likes`, "token-of-enc");
    expect(actions().map((a) => [a.action, a.result])).toEqual([["like", "success"], ["unlike", "success"]]);
  });

  it("works through a post read from Facebook, and is refused without the manage permission", async () => {
    metaPost.mockResolvedValue({ success: true });
    await patch(COMMENT, { kind: "feed", postId: FEED_ID, liked: true });
    expect(actions()).toEqual([expect.objectContaining({ action: "like", post_kind: "feed", post_ref: FEED_ID })]);
    seed(["pages_show_list", "pages_read_user_content"]);
    metaPost.mockClear();
    const res = await patch(COMMENT, { kind: "app", postId: POST_ID, liked: true });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("COMMENTS_SCOPES_MISSING");
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("names the comment, not a post, when Facebook refuses, and reports a comment that is gone", async () => {
    metaPost.mockResolvedValue({ success: false });
    const refused = await patch(COMMENT, { kind: "app", postId: POST_ID, liked: true });
    expect(refused.status).toBe(422);
    expect((await json(refused)).code).toBe("COMMENT_REJECTED");
    metaPost.mockRejectedValue(new MetaApiError("rejected", "100", 400, { subcode: "1" }));
    const content = await patch(COMMENT, { kind: "app", postId: POST_ID, liked: true });
    expect((await json(content)).code).toBe("COMMENT_REJECTED");
    metaDelete.mockRejectedValue(new MetaApiError("does not exist", "100", 400, { subcode: "33" }));
    const gone = await patch(COMMENT, { kind: "app", postId: POST_ID, liked: false });
    expect(gone.status).toBe(404);
    expect((await json(gone)).code).toBe("COMMENT_GONE");
    expect(actions().at(-1)).toMatchObject({ action: "unlike", result: "failed", error_code: "COMMENT_GONE" });
  });

  it("counts toward the same limit of actions per minute", async () => {
    metaPost.mockResolvedValue({ success: true });
    for (let i = 0; i < 30; i++) fake.tables.comment_actions.push({ id: `a${i}`, user_id: "u1", created_at: new Date().toISOString(), action: "like", result: "success" });
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, liked: true })).status).toBe(429);
    expect(metaPost).not.toHaveBeenCalled();
  });
});

describe("editing a comment of the Fanpage", () => {
  const own = { from: { id: "fb-page-1" } };

  it("changes the text of a comment the Page wrote, after checking the author with Facebook, and logs it without the text", async () => {
    metaGet.mockResolvedValue(own);
    metaPost.mockResolvedValue({ success: true });
    const res = await patch(COMMENT, { kind: "app", postId: POST_ID, message: "  Giá 120k nhé  " });
    expect(res.status).toBe(200);
    expect(metaGet).toHaveBeenCalledWith(COMMENT, "token-of-enc", { fields: "from{id}" });
    expect(metaPost).toHaveBeenCalledWith(COMMENT, "token-of-enc", { message: "Giá 120k nhé" });
    expect(actions()).toEqual([expect.objectContaining({ action: "edit", result: "success", facebook_comment_id: COMMENT })]);
    expect(JSON.stringify(actions())).not.toContain("120k");
  });

  it("refuses somebody else's comment before changing anything, and says why", async () => {
    metaGet.mockResolvedValue({ from: { id: "u9" } });
    const res = await patch(COMMENT, { kind: "feed", postId: FEED_ID, message: "Sửa hộ" });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("COMMENT_NOT_OWN");
    expect(metaPost).not.toHaveBeenCalled();
    expect(actions()).toEqual([expect.objectContaining({ action: "edit", result: "failed", error_code: "COMMENT_NOT_OWN" })]);
    metaGet.mockResolvedValue({});
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, message: "x" })).status).toBe(403);
  });

  it("rejects empty or oversized text with the field that is wrong, and more or less than one change per request", async () => {
    for (const message of ["   ", "x".repeat(8001)]) {
      const res = await patch(COMMENT, { kind: "app", postId: POST_ID, message });
      expect(res.status).toBe(400);
      expect((await json(res)).fields).toHaveProperty("message");
    }
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID })).status).toBe(400);
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, message: "a", liked: true })).status).toBe(400);
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, hidden: true, liked: true })).status).toBe(400);
    expect(metaGet).not.toHaveBeenCalled();
    expect(metaPost).not.toHaveBeenCalled();
  });

  it("is refused without the manage permission, and reports a comment that is gone", async () => {
    seed(["pages_show_list", "pages_read_user_content"]);
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, message: "a" })).status).toBe(403);
    expect(metaGet).not.toHaveBeenCalled();
    seed();
    metaGet.mockRejectedValue(new MetaApiError("does not exist", "100", 400, { subcode: "33" }));
    const gone = await patch(COMMENT, { kind: "app", postId: POST_ID, message: "a" });
    expect(gone.status).toBe(404);
    expect((await json(gone)).code).toBe("COMMENT_GONE");
  });

  it("treats an answer of success:false as a refusal of the comment", async () => {
    metaGet.mockResolvedValue(own);
    metaPost.mockResolvedValue({ success: false });
    const res = await patch(COMMENT, { kind: "app", postId: POST_ID, message: "a" });
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe("COMMENT_REJECTED");
  });

  it("still hides a comment (one change per request)", async () => {
    metaPost.mockResolvedValue({ success: true });
    expect((await patch(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(200);
    expect(metaPost).toHaveBeenLastCalledWith(COMMENT, "token-of-enc", { is_hidden: "true" });
  });
});

describe("telling the Page's own comments and likes in the list", () => {
  const graphComment = (id: string, over: Record<string, unknown> = {}) => ({
    id, message: "Giá bao nhiêu?", from: { id: "u9", name: "Nguyễn Văn A" }, created_time: "2026-10-21T08:00:00+0000", like_count: 2, ...over
  });

  it("marks comments written by the Fanpage and the ones it has liked", async () => {
    metaGet.mockResolvedValue({
      data: [graphComment(COMMENT, { from: { id: "fb-page-1", name: "HTStudio" }, user_likes: true }), graphComment("122_5", { user_likes: false })]
    });
    const body = await json(await list(POST_ID));
    expect(body.comments.map((c: { byPage: boolean; likedByPage: boolean }) => [c.byPage, c.likedByPage])).toEqual([[true, true], [false, false]]);
    metaGet.mockResolvedValue({ data: [graphComment("122_6")] });
    const unknown = await json(await list(POST_ID));
    expect(unknown.comments[0].likedByPage).toBeNull();
    expect(metaGet.mock.calls[0][2].fields).toContain("user_likes");
  });
});
