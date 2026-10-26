import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const deactivatePage = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { loadRatings, loadVisitorPosts } from "@/lib/guest-content";
import { MetaApiError } from "@/lib/meta/client";
import {
  mapRating, mapRatings, mapRatingSummary, mapVisitorPost, mapVisitorPosts, RATING_FIELDS_BASIC, RATING_FIELDS_FULL, VISITOR_FIELDS_BASIC, VISITOR_FIELDS_FULL
} from "@/lib/meta/guest";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_user_content"];
const calls = () => metaGet.mock.calls.map((c) => ({ path: c[0] as string, token: c[1] as string, params: c[2] as Record<string, string> }));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e);

const visitor = (id: string, over: Record<string, unknown> = {}) => ({
  id, message: "Shop còn hàng không?", from: { id: "u9", name: "Lan" }, created_time: "2026-10-21T08:00:00+0000",
  permalink_url: "https://www.facebook.com/fb-page-1/posts/1", reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 1 } }, ...over
});

describe("reading visitor posts and ratings (pure)", () => {
  it("maps a visitor post, falls back to Facebook's story when it has no words, and never keeps a link that is not http(s)", () => {
    expect(mapVisitorPost(visitor("111_222"))).toEqual({
      id: "111_222", message: "Shop còn hàng không?", author: "Lan", createdTime: "2026-10-21T08:00:00.000Z",
      permalinkUrl: "https://www.facebook.com/fb-page-1/posts/1", reactions: 2, comments: 1
    });
    expect(mapVisitorPost({ id: "111_222", story: "Lan shared a link." })?.message).toBe("Lan shared a link.");
    expect(mapVisitorPost({ id: "111_222", permalink_url: "javascript:alert(1)" })).toMatchObject({ permalinkUrl: null, author: null, reactions: null, createdTime: null });
  });

  it("drops visitor posts it cannot trust", () => {
    for (const bad of [null, {}, { id: "abc" }, { id: "12/../34" }, { id: "1_2_3" }, { id: 5 }, { id: "123" }]) expect(mapVisitorPost(bad as never)).toBeNull();
    expect(mapVisitorPosts(undefined)).toEqual([]);
    expect(mapVisitorPosts([{ id: "1_2" }, { id: "x" }, { id: "3_4" }]).map((p) => p.id)).toEqual(["1_2", "3_4"]);
  });

  it("maps stars and recommendations, and leaves out ratings with nothing in them", () => {
    expect(mapRating({ rating: 4, review_text: "Tốt", reviewer: { id: "9", name: "Lan" }, created_time: "2026-10-21T08:00:00+0000" })).toMatchObject({
      stars: 4, recommendation: null, text: "Tốt", reviewer: "Lan", createdTime: "2026-10-21T08:00:00.000Z"
    });
    expect(mapRating({ recommendation_type: "negative" })).toMatchObject({ stars: null, recommendation: "negative", text: "", reviewer: null });
    expect(mapRating({ rating: 9, recommendation_type: "maybe" })).toBeNull();
    expect(mapRating({ rating: 2.5 })).toBeNull();
    expect(mapRatings([{ rating: 5 }, {}, { review_text: "Hay" }]).map((r) => r.key)).toHaveLength(2);
    expect(new Set(mapRatings([{ rating: 5 }, { rating: 5 }]).map((r) => r.key)).size).toBe(2);
  });

  it("reads the totals of the Page and ignores what is not a number", () => {
    expect(mapRatingSummary({ rating_count: 12, overall_star_rating: 4.6 })).toEqual({ count: 12, average: 4.6 });
    expect(mapRatingSummary({ rating_count: "12", overall_star_rating: 0 })).toEqual({ count: null, average: null });
    expect(mapRatingSummary(null)).toEqual({ count: null, average: null });
  });
});

function seed(opts: { scopes?: string[]; page?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: opts.scopes ?? SCOPES });
  fake.tables.facebook_pages.push({
    id: PAGE, user_id: "u1", page_id: "fb-page-1", page_name: "HTStudio", connection_id: CONNECTION, page_access_token_encrypted: "enc",
    is_active: true, removed_at: null, ratings_count: null, ...opts.page
  });
}

beforeEach(() => {
  metaGet.mockReset(); deactivatePage.mockReset();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadVisitorPosts", () => {
  it("reads the visitor posts of the Page with the Page's token, and returns only a cursor, never Facebook's link", async () => {
    metaGet.mockResolvedValue({ data: [visitor("fb-page-1_1".replace("fb-page-1", "1171"))], paging: { cursors: { after: "CUR2" }, next: "https://graph.facebook.com/x?access_token=SECRET" } });
    const result = await loadVisitorPosts("u1", PAGE);
    expect(calls()).toEqual([{ path: "fb-page-1/visitor_posts", token: "token-of-enc", params: { fields: VISITOR_FIELDS_FULL, limit: "20" } }]);
    expect(result.items).toHaveLength(1);
    expect(result.next).toBe("CUR2");
    expect(result.page).toEqual({ id: PAGE, page_id: "fb-page-1", page_name: "HTStudio" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("follows a cursor, has no next page at the end, and refuses a malformed cursor before asking Facebook", async () => {
    metaGet.mockResolvedValue({ data: [], paging: { cursors: { after: "CUR9" } } });
    expect((await loadVisitorPosts("u1", PAGE, "CUR2")).next).toBeNull();
    expect(calls()[0].params).toMatchObject({ after: "CUR2" });
    metaGet.mockClear();
    expect(await failure(loadVisitorPosts("u1", PAGE, "a/../b"))).toMatchObject({ code: "INVALID_REQUEST" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("asks again for the plain fields if Facebook refuses one", async () => {
    metaGet.mockRejectedValueOnce(new MetaApiError("(#100) bad field", "100", 400)).mockResolvedValue({ data: [visitor("1_2")] });
    expect((await loadVisitorPosts("u1", PAGE)).items).toHaveLength(1);
    expect(calls()[1].params.fields).toBe(VISITOR_FIELDS_BASIC);
  });

  it("says the posts cannot be read, not that a post was rejected or is gone, when Facebook refuses even the plain fields", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#100) Unsupported get request", "100", 400, { subcode: "33" }));
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "GUEST_POSTS_UNAVAILABLE" });
    expect(metaGet).toHaveBeenCalledTimes(2);
  });

  it("says what is missing for the Page without asking Facebook: unknown, removed, off, or the permission never granted", async () => {
    expect(await failure(loadVisitorPosts("someone-else", PAGE))).toMatchObject({ code: "PAGE_NOT_FOUND" });
    seed({ page: { removed_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "PAGE_REMOVED_ACTION" });
    seed({ page: { is_active: false } });
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "PAGE_INACTIVE" });
    seed({ scopes: ["pages_show_list", "pages_manage_posts"] });
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "GUEST_SCOPES_MISSING" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("tells a refused Page, a dead token and a rate limit apart", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#10) Requires pages_read_user_content", "10", 403));
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "GUEST_PERMISSION_DENIED" });
    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("Error validating access token", "190", 400));
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "PAGE_PERMISSION_LOST" });
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);
    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("limit", "4", 400));
    expect(await failure(loadVisitorPosts("u1", PAGE))).toMatchObject({ code: "FB_RATE_LIMITED" });
  });
});

describe("loadRatings", () => {
  const answer = (path: string) => {
    if (path.endsWith("/ratings")) return { data: [{ rating: 5, review_text: "Tuyệt", reviewer: { id: "9", name: "Lan" } }, { recommendation_type: "positive" }], paging: { cursors: { after: "R2" }, next: "https://x" } };
    return { rating_count: 12, overall_star_rating: 4.5 };
  };

  it("reads the ratings and the Page's totals on the first page", async () => {
    metaGet.mockImplementation(async (path: string) => answer(path));
    const result = await loadRatings("u1", PAGE);
    expect(calls()[0]).toEqual({ path: "fb-page-1/ratings", token: "token-of-enc", params: { fields: RATING_FIELDS_FULL, limit: "20" } });
    expect(calls()[1]).toMatchObject({ path: "fb-page-1", params: { fields: "rating_count,overall_star_rating" } });
    expect(result.items).toHaveLength(2);
    expect(result.summary).toEqual({ count: 12, average: 4.5 });
    expect(result.next).toBe("R2");
  });

  it("does not ask for the totals again on the next pages, and still lists when they cannot be read", async () => {
    metaGet.mockImplementation(async (path: string) => answer(path));
    expect((await loadRatings("u1", PAGE, "R2")).summary).toBeNull();
    expect(calls()).toHaveLength(1);
    metaGet.mockReset();
    metaGet.mockImplementation(async (path: string) => { if (path.endsWith("/ratings")) return answer(path); throw new MetaApiError("odd", "100", 400); });
    const result = await loadRatings("u1", PAGE);
    expect(result.items).toHaveLength(2);
    expect(result.summary).toBeNull();
  });

  it("asks for the plain fields once, and says the Page has no ratings when Facebook refuses those too", async () => {
    metaGet.mockRejectedValueOnce(new MetaApiError("(#100) bad field", "100", 400)).mockImplementation(async (path: string) => answer(path));
    expect((await loadRatings("u1", PAGE)).items).toHaveLength(2);
    expect(calls()[1].params.fields).toBe(RATING_FIELDS_BASIC);
    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("(#100) nonexisting field (ratings)", "100", 400));
    expect(await failure(loadRatings("u1", PAGE))).toMatchObject({ code: "RATINGS_UNAVAILABLE" });
    expect(metaGet).toHaveBeenCalledTimes(2);
  });

  it("opening the first page marks the ratings as seen with the live total, and reads the notification; later pages do not", async () => {
    seed({ page: { ratings_count: 10 } });
    fake.tables.notifications.push({ id: "n1", user_id: "u1", type: "NEW_RATINGS", page_id: PAGE, params: { count: 2 }, read_at: null });
    metaGet.mockImplementation(async (path: string) => answer(path));
    await loadRatings("u1", PAGE, "R2");
    expect(fake.tables.notifications[0].read_at ?? null).toBeNull();
    await loadRatings("u1", PAGE);
    expect(fake.tables.facebook_pages[0]).toMatchObject({ ratings_count: 12 });
    expect(fake.tables.notifications[0].read_at).not.toBeNull();
  });

  it("does not mark anything as seen when the read failed", async () => {
    seed({ page: { ratings_count: 10 } });
    fake.tables.notifications.push({ id: "n1", user_id: "u1", type: "NEW_RATINGS", page_id: PAGE, params: { count: 2 }, read_at: null });
    metaGet.mockRejectedValue(new MetaApiError("(#10) denied", "10", 403));
    expect(await failure(loadRatings("u1", PAGE))).toMatchObject({ code: "GUEST_PERMISSION_DENIED" });
    expect(fake.tables.notifications[0].read_at ?? null).toBeNull();
    expect(fake.tables.facebook_pages[0]).toMatchObject({ ratings_count: 10 });
  });
});
