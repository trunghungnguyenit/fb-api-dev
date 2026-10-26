import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const metaPost = vi.fn();
const metaDelete = vi.fn();
const requireUser = vi.fn();
const isSameOrigin = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: () => requireUser() }));
vi.mock("@/lib/csrf", () => ({ isSameOrigin: () => isSameOrigin() }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaGet: (...a: unknown[]) => metaGet(...a), metaPost: (...a: unknown[]) => metaPost(...a), metaDelete: (...a: unknown[]) => metaDelete(...a)
}));

import { GET as listRoute, POST as replyRoute } from "@/app/api/posts/[id]/comments/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/comments/[commentId]/route";
import { kindSchema } from "@/lib/comments-http";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const FB_PAGE = "1171329916068581";
const VISITOR_POST = `${FB_PAGE}_5550001`;
const COMMENT = "5550001_998877";
const ALL_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement"];

const json = (res: Response) => res.json();
const call = (handler: (r: NextRequest, c: never) => Promise<Response>, url: string, method: string, body: unknown, params: unknown) =>
  handler(new NextRequest(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve(params) } as never);
const get = (query: string, id = PAGE) => listRoute(new NextRequest(`http://localhost/api/posts/${id}/comments?${query}`), { params: Promise.resolve({ id }) });
const reply = (body: unknown, id = PAGE) => call(replyRoute as never, `http://localhost/api/posts/${id}/comments`, "POST", body, { id });
const patch = (commentId: string, body: unknown) => call(patchRoute as never, `http://localhost/api/comments/${commentId}`, "PATCH", body, { commentId });
const remove = (commentId: string, query: string) => call(deleteRoute as never, `http://localhost/api/comments/${commentId}?${query}`, "DELETE", undefined, { commentId });
const actions = () => fake.tables.comment_actions;

function seed(page: Record<string, unknown> = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: ALL_SCOPES });
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_id: FB_PAGE, connection_id: CONNECTION, page_access_token_encrypted: "enc", is_active: true, removed_at: null, ...page });
  fake.tables.page_feed_posts.push({ id: "f1", user_id: "u1", page_id: PAGE, facebook_post_id: VISITOR_POST, comments_count: 4, comments_seen_count: 4, missing_since: null });
}

beforeEach(() => {
  metaGet.mockReset(); metaPost.mockReset(); metaDelete.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  isSameOrigin.mockReturnValue(true);
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("comments under a post a visitor wrote on the Fanpage wall", () => {
  it("lists them with the Page's token for the visitor post named in the request", async () => {
    metaGet.mockResolvedValue({ data: [{ id: COMMENT, message: "Còn hàng nhé", from: { id: "u9", name: "Lan" } }], summary: { total_count: 1 } });
    const res = await get(`kind=visitor&fbPost=${VISITOR_POST}`);
    expect(res.status).toBe(200);
    expect(metaGet.mock.calls[0][0]).toBe(`${VISITOR_POST}/comments`);
    expect(metaGet.mock.calls[0][1]).toBe("token-of-enc");
    expect((await json(res)).comments).toHaveLength(1);
  });

  it("does not touch the stored comment counts of the Fanpage's own posts (a visitor post has none)", async () => {
    metaGet.mockResolvedValue({ data: [], summary: { total_count: 99 } });
    await get(`kind=visitor&fbPost=${VISITOR_POST}`);
    expect(fake.tables.page_feed_posts[0]).toMatchObject({ comments_count: 4, comments_seen_count: 4 });
    metaPost.mockResolvedValue({ id: "5550001_1" });
    expect((await reply({ kind: "visitor", facebookPostId: VISITOR_POST, message: "Còn ạ" })).status).toBe(201);
    expect(metaPost).toHaveBeenCalledWith(VISITOR_POST + "/comments", "token-of-enc", { message: "Còn ạ" });
    expect(fake.tables.page_feed_posts[0]).toMatchObject({ comments_count: 4, comments_seen_count: 4 });
  });

  it("refuses a visitor post that is missing, malformed, or belongs to another Fanpage, before asking Facebook", async () => {
    expect((await get("kind=visitor")).status).toBe(400);
    expect((await get("kind=visitor&fbPost=not-an-id")).status).toBe(400);
    expect((await get("kind=visitor&fbPost=999_5550001")).status).toBe(400);
    expect((await reply({ kind: "visitor", message: "x" })).status).toBe(400);
    expect((await reply({ kind: "visitor", facebookPostId: "999_1", message: "x" })).status).toBe(400);
    expect((await patch(COMMENT, { kind: "visitor", postId: PAGE, facebookPostId: "999_1", liked: true })).status).toBe(400);
    expect((await remove(COMMENT, `kind=visitor&postId=${PAGE}&fbPost=999_1`)).status).toBe(400);
    expect(metaGet).not.toHaveBeenCalled();
    expect(metaPost).not.toHaveBeenCalled();
    expect(metaDelete).not.toHaveBeenCalled();
  });

  it("is only for the user's own Fanpage, a Fanpage that is still connected and switched on", async () => {
    seed({ user_id: "u2" });
    expect((await get(`kind=visitor&fbPost=${VISITOR_POST}`)).status).toBe(404);
    seed({ removed_at: "2026-10-01T00:00:00Z" });
    expect((await get(`kind=visitor&fbPost=${VISITOR_POST}`)).status).toBe(409);
    seed({ is_active: false });
    expect((await get(`kind=visitor&fbPost=${VISITOR_POST}`)).status).toBe(409);
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("likes, hides and deletes a comment there, and logs it as a visitor post without any link to a stored row", async () => {
    metaPost.mockResolvedValue({ success: true });
    metaDelete.mockResolvedValue({ success: true });
    expect((await patch(COMMENT, { kind: "visitor", postId: PAGE, facebookPostId: VISITOR_POST, liked: true })).status).toBe(200);
    expect((await patch(COMMENT, { kind: "visitor", postId: PAGE, facebookPostId: VISITOR_POST, hidden: true })).status).toBe(200);
    expect((await remove(COMMENT, `kind=visitor&postId=${PAGE}&fbPost=${VISITOR_POST}`)).status).toBe(200);
    expect(actions().map((a) => [a.action, a.result, a.post_kind, a.post_ref ?? null, a.facebook_post_id])).toEqual([
      ["like", "success", "visitor", null, VISITOR_POST], ["hide", "success", "visitor", null, VISITOR_POST], ["delete", "success", "visitor", null, VISITOR_POST]
    ]);
  });

  it("edits only the Fanpage's own comments there too", async () => {
    metaGet.mockResolvedValue({ from: { id: "someone" } });
    const refused = await patch(COMMENT, { kind: "visitor", postId: PAGE, facebookPostId: VISITOR_POST, message: "Sửa" });
    expect(refused.status).toBe(403);
    expect((await json(refused)).code).toBe("COMMENT_NOT_OWN");
    metaGet.mockResolvedValue({ from: { id: FB_PAGE } });
    metaPost.mockResolvedValue({ success: true });
    expect((await patch(COMMENT, { kind: "visitor", postId: PAGE, facebookPostId: VISITOR_POST, message: "Sửa" })).status).toBe(200);
  });

  it("the kind is one of exactly the kinds the log accepts", () => {
    expect(kindSchema.options).toEqual(["app", "feed", "visitor"]);
  });
});
