import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const deactivatePage = vi.fn();
const requireUser = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/auth", () => ({ requireUser: () => requireUser() }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { GET } from "@/app/api/posts/[id]/reactions/route";
import { ERROR_MESSAGES } from "@/lib/errors";
import { MetaApiError } from "@/lib/meta/client";
import { parseReactions, REACTION_TYPES, reactionFields } from "@/lib/meta/post-reactions";
import { clearPostReactionsCache, loadPostReactions } from "@/lib/post-reactions";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const POST = "22222222-2222-4222-8222-222222222222";
const FEED = "33333333-3333-4333-8333-333333333333";
const FB_POST = "1171329916068581_122111511207403780";

const summary = (n: number) => ({ data: [], summary: { total_count: n } });
const body = (counts: Partial<Record<string, number>>, total?: number) => ({
  total: summary(total ?? Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0)),
  ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, summary(v ?? 0)]))
});
const calls = () => metaGet.mock.calls.map((c) => ({ path: c[0] as string, token: c[1] as string, fields: (c[2] as Record<string, string>).fields }));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e);

function seed(opts: { page?: Record<string, unknown>; post?: Record<string, unknown>; feed?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: ["pages_show_list", "pages_read_engagement"] });
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_id: "fb-page-1", connection_id: CONNECTION, page_access_token_encrypted: "enc", is_active: true, removed_at: null, ...opts.page });
  fake.tables.posts.push({ id: POST, user_id: "u1", page_id: PAGE, status: "published", post_type: "photo", facebook_post_id: FB_POST, facebook_deleted_at: null, ...opts.post });
  fake.tables.page_feed_posts.push({ id: FEED, user_id: "u1", page_id: PAGE, facebook_post_id: FB_POST, status_type: "added_photos", missing_since: null, post_id: null, ...opts.feed });
}

beforeEach(() => {
  metaGet.mockReset(); deactivatePage.mockReset(); requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  clearPostReactionsCache();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reading Facebook's answer (pure)", () => {
  it("asks for the total and each kind in one request, every answer under its own name", () => {
    const fields = reactionFields(REACTION_TYPES);
    expect(fields.split(",")).toHaveLength(8);
    expect(fields).toContain("reactions.limit(0).summary(total_count).as(total)");
    expect(fields).toContain("reactions.type(LOVE).limit(0).summary(total_count).as(love)");
    expect(fields).toContain("reactions.type(SAD).limit(0).summary(total_count).as(sorry)");
    expect(reactionFields(REACTION_TYPES.slice(0, 1), false)).toBe("reactions.type(LIKE).limit(0).summary(total_count).as(like)");
  });

  it("gives the kinds in Facebook's usual order with Vietnamese names; what Facebook did not give stays empty", () => {
    const view = parseReactions({ total: summary(9), like: summary(5), love: summary(3), wow: { summary: { total_count: "x" } }, haha: summary(0), junk: summary(100) });
    expect(view.total).toBe(9);
    expect(view.types.map((t) => [t.label, t.value])).toEqual([
      ["Thích", 5], ["Yêu thích", 3], ["Thương thương", null], ["Haha", 0], ["Wow", null], ["Buồn", null], ["Phẫn nộ", null]
    ]);
    expect(parseReactions(null).total).toBeNull();
    expect(parseReactions({ like: summary(-2) }).types[0].value).toBeNull();
  });
});

describe("loadPostReactions", () => {
  it("reads every kind in one request with the Page's token, for the app's post and for a post read from the Fanpage", async () => {
    metaGet.mockResolvedValue(body({ like: 7, love: 3, care: 0, haha: 1, wow: 0, sorry: 0, anger: 0 }));
    const result = await loadPostReactions("u1", { kind: "app", id: POST });
    expect(calls()).toEqual([{ path: FB_POST, token: "token-of-enc", fields: reactionFields(REACTION_TYPES) }]);
    expect(result.total).toBe(11);
    expect(result.types.map((t) => t.value)).toEqual([7, 3, 0, 1, 0, 0, 0]);
    await loadPostReactions("u1", { kind: "feed", id: FEED });
    expect(calls()).toHaveLength(2);
  });

  it("takes videos and Reels too (their Insights are not read, their reactions are)", async () => {
    metaGet.mockResolvedValue(body({ like: 1 }));
    seed({ post: { post_type: "reel" }, feed: { status_type: "added_video" } });
    expect((await loadPostReactions("u1", { kind: "app", id: POST })).total).toBe(1);
    expect((await loadPostReactions("u1", { kind: "feed", id: FEED })).total).toBe(1);
  });

  it("asks kind by kind when Facebook refuses the combined request, and leaves only the refused kind empty", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const fields = params.fields;
      if (fields.split(",").length > 1) throw new MetaApiError("(#100) Invalid reaction type", "100", 400);
      if (fields.includes("type(SAD)")) throw new MetaApiError("(#100) Invalid reaction type", "100", 400);
      if (fields.includes("type(LIKE)")) return { like: summary(4) };
      if (fields.includes("type(LOVE)")) return { love: summary(2) };
      if (fields.includes(".as(total)")) return { total: summary(9) };
      return { [/as\((\w+)\)/.exec(fields)![1]]: summary(0) };
    });
    const result = await loadPostReactions("u1", { kind: "app", id: POST });
    expect(calls()).toHaveLength(1 + 1 + REACTION_TYPES.length);
    expect(result.total).toBe(9);
    expect(result.types.map((t) => [t.key, t.value])).toEqual([["like", 4], ["love", 2], ["care", 0], ["haha", 0], ["wow", 0], ["sorry", null], ["anger", 0]]);
    // the same post is not asked nine times again on the next visit
    expect(await loadPostReactions("u1", { kind: "app", id: POST })).toEqual(result);
    expect(calls()).toHaveLength(1 + 1 + REACTION_TYPES.length);
  });

  it("does not retry kind by kind for a refused Page, a dead token or a rate limit", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#10) Requires pages_read_engagement", "10", 403));
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "REACTIONS_PERMISSION_DENIED" });
    expect(metaGet).toHaveBeenCalledTimes(1);

    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("Error validating access token", "190", 400));
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_PERMISSION_LOST" });
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);

    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("limit", "4", 400));
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "FB_RATE_LIMITED" });
  });

  it("says the post is gone, not 'reconnect', when Facebook no longer finds it", async () => {
    metaGet.mockRejectedValue(new MetaApiError("Unsupported get request", "100", 400, { subcode: "33" }));
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "REACTIONS_POST_UNAVAILABLE", gone: true });
    expect(metaGet).toHaveBeenCalledTimes(1);
    metaGet.mockReset();
    metaGet.mockRejectedValue(new MetaApiError("(#10) Object does not exist, cannot be loaded due to missing permission or review", "10", 403));
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "REACTIONS_POST_UNAVAILABLE" });
  });

  it("does not ask Facebook about posts that are not live, other users' posts, or a Page that is removed or off", async () => {
    seed({ post: { status: "draft" } });
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "REACTIONS_POST_UNAVAILABLE" });
    seed({ post: { facebook_deleted_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "REACTIONS_POST_UNAVAILABLE" });
    seed({ feed: { missing_since: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadPostReactions("u1", { kind: "feed", id: FEED }))).toMatchObject({ code: "REACTIONS_POST_UNAVAILABLE" });
    seed();
    expect(await failure(loadPostReactions("someone-else", { kind: "app", id: POST }))).toMatchObject({ code: "POST_NOT_FOUND" });
    seed({ page: { removed_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_REMOVED_ACTION" });
    seed({ page: { is_active: false } });
    expect(await failure(loadPostReactions("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_INACTIVE" });
    expect(metaGet).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts/[id]/reactions", () => {
  const get = (id: string, query: string) => GET(new NextRequest(`http://localhost/api/posts/${id}/reactions?${query}`), { params: Promise.resolve({ id }) });

  it("needs a signed-in user and a valid post and kind", async () => {
    requireUser.mockResolvedValue(null);
    expect((await get(POST, "kind=app")).status).toBe(401);
    requireUser.mockResolvedValue({ id: "u1" });
    expect((await get(POST, "kind=other")).status).toBe(404);
    expect((await get("not-a-uuid", "kind=app")).status).toBe(404);
    expect((await get("99999999-9999-4999-8999-999999999999", "kind=app")).status).toBe(404);
  });

  it("answers with the numbers, uncached", async () => {
    metaGet.mockResolvedValue(body({ like: 2 }));
    const res = await get(POST, "kind=app");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ total: 2, types: expect.any(Array) });
  });

  it("failures come as our own wording with the right status, never Facebook's text", async () => {
    metaGet.mockRejectedValue(new MetaApiError("SECRET raw text from Facebook (#10)", "10", 403));
    const res = await get(POST, "kind=app");
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json).toMatchObject({ code: "REACTIONS_PERMISSION_DENIED", error: ERROR_MESSAGES.REACTIONS_PERMISSION_DENIED });
    expect(JSON.stringify(json)).not.toContain("SECRET");

    seed({ post: { status: "draft" } });
    const gone = await get(POST, "kind=app");
    expect(gone.status).toBe(409);
    expect((await gone.json()).code).toBe("REACTIONS_POST_UNAVAILABLE");
  });
});
