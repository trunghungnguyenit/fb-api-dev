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

import { GET as listRoute, POST as replyRoute } from "@/app/api/posts/[id]/comments/route";
import { PATCH as hideRoute, DELETE as deleteRoute } from "@/app/api/comments/[commentId]/route";
import { MetaApiError, MetaRateLimitedError } from "@/lib/meta/client";
import { COMMENT_FIELDS_BASIC, COMMENT_FIELDS_FULL } from "@/lib/meta/comments";

const POST_ID = "22222222-2222-4222-8222-222222222222";
const FEED_ID = "33333333-3333-4333-8333-333333333333";
const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const FB_POST = "1171329916068581_122111511207403780";
const COMMENT = "122111511207403780_998877";
const ALL_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement"];

const json = (res: Response) => res.json();
const get = (id: string, query: string) => listRoute(new NextRequest(`http://localhost/api/posts/${id}/comments?${query}`), { params: Promise.resolve({ id }) });
const send = (handler: (r: NextRequest, c: never) => Promise<Response>, url: string, method: string, body: unknown, params: unknown) =>
  handler(new NextRequest(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve(params) } as never);
const reply = (body: unknown, id = POST_ID) => send(replyRoute as never, `http://localhost/api/posts/${id}/comments`, "POST", body, { id });
const hide = (commentId: string, body: unknown) => send(hideRoute as never, `http://localhost/api/comments/${commentId}`, "PATCH", body, { commentId });
const remove = (commentId: string, query: string) => send(deleteRoute as never, `http://localhost/api/comments/${commentId}?${query}`, "DELETE", undefined, { commentId });

const graphComment = (id: string, over: Record<string, unknown> = {}) => ({
  id, message: "Giá bao nhiêu?", from: { id: "u9", name: "Nguyễn Văn A" }, created_time: "2026-10-21T08:00:00+0000",
  like_count: 2, comment_count: 1, is_hidden: false, can_hide: true, can_remove: true, can_comment: true, ...over
});

function seed(opts: { scopes?: string[]; post?: Record<string, unknown>; page?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: opts.scopes ?? ALL_SCOPES });
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_id: "fb-page-1", connection_id: CONNECTION, page_access_token_encrypted: "enc", is_active: true, removed_at: null, ...opts.page });
  fake.tables.posts.push({ id: POST_ID, user_id: "u1", page_id: PAGE, status: "published", facebook_post_id: FB_POST, facebook_deleted_at: null, ...opts.post });
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

describe("reading comments", () => {
  it("lists a post's comments with the Page's token, newest first, and returns only what the screen needs", async () => {
    metaGet.mockResolvedValue({
      data: [graphComment(COMMENT, { is_hidden: true })],
      paging: { cursors: { after: "CURSOR2" }, next: "https://graph.facebook.com/x?access_token=SECRET" }, summary: { total_count: 41 }
    });
    const res = await get(POST_ID, "kind=app");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(metaGet).toHaveBeenCalledWith(`${FB_POST}/comments`, "token-of-enc", {
      fields: COMMENT_FIELDS_FULL, limit: "25", filter: "toplevel", summary: "1", order: "reverse_chronological"
    });
    const body = await json(res);
    expect(body).toMatchObject({
      next: "CURSOR2", total: 41, access: { read: true, manage: true },
      comments: [{ id: COMMENT, message: "Giá bao nhiêu?", author: "Nguyễn Văn A", isHidden: true, likeCount: 2, replyCount: 1, canHide: true, canRemove: true, canReply: true }]
    });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(actions() ?? []).toHaveLength(0); // reading is not logged, and nothing about the comments is stored
    expect(fake.tables.comment_actions).toHaveLength(0);
  });

  it("follows a cursor, and loads replies oldest first", async () => {
    metaGet.mockResolvedValue({ data: [] });
    await get(POST_ID, "kind=app&after=CURSOR2");
    expect(metaGet.mock.calls[0][2]).toMatchObject({ after: "CURSOR2" });
    await get(POST_ID, `kind=app&parent=${COMMENT}`);
    expect(metaGet.mock.calls[1][0]).toBe(`${COMMENT}/comments`);
    expect(metaGet.mock.calls[1][2]).toMatchObject({ order: "chronological" });
  });

  it("gives no next page at the end, even if Facebook sent a cursor", async () => {
    metaGet.mockResolvedValue({ data: [graphComment(COMMENT)], paging: { cursors: { after: "LAST" } } });
    expect((await json(await get(POST_ID, "kind=app"))).next).toBeNull();
  });

  it("works for a post read from Facebook too", async () => {
    metaGet.mockResolvedValue({ data: [graphComment(COMMENT)] });
    const res = await get(FEED_ID, "kind=feed");
    expect(res.status).toBe(200);
    expect(metaGet.mock.calls[0][0]).toBe(`${FB_POST}/comments`);
  });

  it("falls back to the plain comment fields if Facebook refuses one", async () => {
    metaGet.mockRejectedValueOnce(new MetaApiError("(#100) bad field", "100", 400)).mockResolvedValue({ data: [graphComment(COMMENT)] });
    const res = await get(POST_ID, "kind=app");
    expect(res.status).toBe(200);
    expect(metaGet.mock.calls[1][2]).toMatchObject({ fields: COMMENT_FIELDS_BASIC });
  });

  it("refuses posts that cannot have comments, other users' posts, and Pages that are off", async () => {
    const status = async (id: string, kind = "app") => (await get(id, `kind=${kind}`)).status;
    seed({ post: { status: "draft" } });
    expect(await status(POST_ID)).toBe(409);
    seed({ post: { facebook_deleted_at: "2026-10-20T00:00:00Z" } });
    expect(await status(POST_ID)).toBe(409);
    seed(); fake.tables.page_feed_posts[0].missing_since = "2026-10-20T00:00:00Z";
    expect(await status(FEED_ID, "feed")).toBe(409);
    seed({ post: { user_id: "u2" } });
    expect(await status(POST_ID)).toBe(404);
    seed({ page: { removed_at: "2026-10-20T00:00:00Z" } });
    expect(await status(POST_ID)).toBe(409);
    seed({ page: { is_active: false } });
    expect(await status(POST_ID)).toBe(409);
    expect(await status("not-a-uuid")).toBe(400);
    expect(await status(POST_ID, "other")).toBe(400);
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("needs a signed-in user", async () => {
    requireUser.mockResolvedValue(null);
    expect((await get(POST_ID, "kind=app")).status).toBe(401);
  });

  it("rejects malformed cursors and comment ids", async () => {
    expect((await get(POST_ID, "kind=app&after=" + encodeURIComponent("a b&c"))).status).toBe(400);
    expect((await get(POST_ID, "kind=app&parent=abc")).status).toBe(400);
    expect(metaGet).not.toHaveBeenCalled();
  });
});

describe("permissions", () => {
  it("does not call Facebook when the comment permissions were never granted, and says how to fix it", async () => {
    seed({ scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"] });
    const res = await get(POST_ID, "kind=app");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("COMMENTS_SCOPES_MISSING");
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("with read-only permission, comments can be read but not changed", async () => {
    seed({ scopes: ["pages_show_list", "pages_manage_posts", "pages_read_user_content"] });
    metaGet.mockResolvedValue({ data: [graphComment(COMMENT)] });
    expect((await json(await get(POST_ID, "kind=app"))).access).toEqual({ read: true, manage: false });

    expect((await reply({ kind: "app", message: "ok" })).status).toBe(403);
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(403);
    expect((await remove(COMMENT, `kind=app&postId=${POST_ID}`)).status).toBe(403);
    expect(metaPost).not.toHaveBeenCalled();
    expect(metaDelete).not.toHaveBeenCalled();
  });

  it("maps Facebook's refusals to clear messages", async () => {
    const code = async (error: Error) => { metaGet.mockRejectedValue(error); const res = await get(POST_ID, "kind=app"); return [res.status, (await json(res)).code]; };
    expect(await code(new MetaApiError("(#10) permission", "10", 403))).toEqual([403, "COMMENTS_PERMISSION_DENIED"]);
    expect(await code(new MetaApiError("(#200) permission", "200", 403))).toEqual([403, "COMMENTS_PERMISSION_DENIED"]);
    expect(await code(new MetaApiError("does not exist", "100", 400, { subcode: "33" }))).toEqual([404, "COMMENT_GONE"]);
    expect(await code(new MetaApiError("too many calls", "32", 400))).toEqual([429, "FB_RATE_LIMITED"]);
    expect(await code(new MetaRateLimitedError(Date.now() + 1000))).toEqual([429, "FB_RATE_LIMITED"]);
    expect(await code(new Error("network"))).toEqual([502, "FB_UNAVAILABLE"]);
  });

  it("switches the Page off when its token is dead", async () => {
    metaGet.mockRejectedValue(new MetaApiError("token expired", "190", 401));
    const res = await get(POST_ID, "kind=app");
    expect(res.status).toBe(409);
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);
  });
});

describe("replying", () => {
  it("replies to a comment as the Page and logs it without any text", async () => {
    metaPost.mockResolvedValue({ id: "122111511207403780_5551" });
    const res = await reply({ kind: "app", message: "  Giá 100k bạn nhé  ", replyTo: COMMENT });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ id: "122111511207403780_5551" });
    expect(metaPost).toHaveBeenCalledWith(`${COMMENT}/comments`, "token-of-enc", { message: "Giá 100k bạn nhé" });
    expect(actions()).toEqual([expect.objectContaining({
      user_id: "u1", page_id: PAGE, facebook_page_id: "fb-page-1", post_kind: "app", post_ref: POST_ID, facebook_post_id: FB_POST,
      facebook_comment_id: COMMENT, action: "reply", result: "success", result_comment_id: "122111511207403780_5551", error_code: null
    })]);
    expect(JSON.stringify(actions())).not.toContain("Giá 100k");
  });

  it("comments on the post itself when there is nothing to reply to", async () => {
    metaPost.mockResolvedValue({ id: "c1_c2" });
    await reply({ kind: "app", message: "Cảm ơn mọi người" });
    expect(metaPost.mock.calls[0][0]).toBe(`${FB_POST}/comments`);
  });

  it("rejects empty or oversized text and bad ids before anything reaches Facebook", async () => {
    for (const body of [
      { kind: "app", message: "   " }, { kind: "app", message: "x".repeat(8001) }, { kind: "app", message: "ok", replyTo: "abc" },
      { kind: "other", message: "ok" }, { message: "ok" }
    ]) expect((await reply(body)).status).toBe(400);
    expect(metaPost).not.toHaveBeenCalled();
    expect(actions() ?? []).toHaveLength(0);
  });

  it("logs a refused reply with its reason, and tells the user", async () => {
    metaPost.mockRejectedValue(new MetaApiError("(#200) permission", "200", 403));
    const res = await reply({ kind: "app", message: "ok", replyTo: COMMENT });
    expect(res.status).toBe(403);
    expect(actions()).toEqual([expect.objectContaining({ action: "reply", result: "failed", error_code: "COMMENTS_PERMISSION_DENIED", result_comment_id: null })]);
  });

  it("needs the same-origin check and a signed-in user", async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await reply({ kind: "app", message: "ok" })).status).toBe(403);
    isSameOrigin.mockReturnValue(true);
    requireUser.mockResolvedValue(null);
    expect((await reply({ kind: "app", message: "ok" })).status).toBe(401);
    expect(metaPost).not.toHaveBeenCalled();
  });
});

describe("hiding and deleting", () => {
  it("hides and shows a comment", async () => {
    metaPost.mockResolvedValue({ success: true });
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(200);
    expect(metaPost).toHaveBeenLastCalledWith(COMMENT, "token-of-enc", { is_hidden: "true" });
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: false })).status).toBe(200);
    expect(metaPost).toHaveBeenLastCalledWith(COMMENT, "token-of-enc", { is_hidden: "false" });
    expect(actions().map((a) => [a.action, a.result])).toEqual([["hide", "success"], ["unhide", "success"]]);
  });

  it("deletes a comment", async () => {
    metaDelete.mockResolvedValue({ success: true });
    expect((await remove(COMMENT, `kind=app&postId=${POST_ID}`)).status).toBe(200);
    expect(metaDelete).toHaveBeenCalledWith(COMMENT, "token-of-enc");
    expect(actions()).toEqual([expect.objectContaining({ action: "delete", result: "success", facebook_comment_id: COMMENT })]);
  });

  it("works through a post read from Facebook as well", async () => {
    metaPost.mockResolvedValue({ success: true });
    await hide(COMMENT, { kind: "feed", postId: FEED_ID, hidden: true });
    expect(actions()).toEqual([expect.objectContaining({ post_kind: "feed", post_ref: FEED_ID })]);
  });

  it("reports a comment that is already gone, and logs the failed attempt", async () => {
    metaDelete.mockRejectedValue(new MetaApiError("does not exist", "100", 400, { subcode: "33" }));
    const res = await remove(COMMENT, `kind=app&postId=${POST_ID}`);
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("COMMENT_GONE");
    expect(actions()).toEqual([expect.objectContaining({ action: "delete", result: "failed", error_code: "COMMENT_GONE" })]);
  });

  it("treats an answer of success:false as a refusal", async () => {
    metaPost.mockResolvedValue({ success: false });
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(422);
  });

  it("rejects bad comment ids and another user's post", async () => {
    expect((await hide("not-an-id", { kind: "app", postId: POST_ID, hidden: true })).status).toBe(400);
    expect((await remove("12/../34", `kind=app&postId=${POST_ID}`)).status).toBe(400);
    seed({ post: { user_id: "u2" } });
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(404);
    expect((await remove(COMMENT, `kind=app&postId=${POST_ID}`)).status).toBe(404);
    expect(metaPost).not.toHaveBeenCalled();
    expect(metaDelete).not.toHaveBeenCalled();
  });

  it("slows down a user who acts too fast, counted from the log", async () => {
    metaPost.mockResolvedValue({ success: true });
    for (let i = 0; i < 30; i++) {
      fake.tables.comment_actions.push({ id: `a${i}`, user_id: "u1", created_at: new Date().toISOString(), action: "hide", result: "success" });
    }
    const res = await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true });
    expect(res.status).toBe(429);
    expect(metaPost).not.toHaveBeenCalled();
    // another user, or older actions, are not affected
    fake.tables.comment_actions.forEach((a) => { a.created_at = new Date(Date.now() - 5 * 60_000).toISOString(); });
    expect((await hide(COMMENT, { kind: "app", postId: POST_ID, hidden: true })).status).toBe(200);
  });
});
