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

import { GET } from "@/app/api/posts/[id]/insights/route";
import { ERROR_MESSAGES } from "@/lib/errors";
import { clearInsightsCache } from "@/lib/insights";
import { MetaApiError } from "@/lib/meta/client";
import { formatDuration, metricsFor, parsePostInsights, POST_METRICS, postValue, REEL_METRICS, VIDEO_METRICS } from "@/lib/meta/post-insights";
import { clearPostInsightsCache, clearVideoLookupCache, loadPostInsights } from "@/lib/post-insights";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const POST = "22222222-2222-4222-8222-222222222222";
const FEED = "33333333-3333-4333-8333-333333333333";
const FB_POST = "1171329916068581_122111511207403780";
const SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights"];
const GRAPH = POST_METRICS.map((m) => m.graph);

describe("reading Facebook's answer (pure)", () => {
  it("takes the latest value of each metric, and nothing for what is not a number", () => {
    const parsed = parsePostInsights({
      data: [
        { name: "post_media_view", values: [{ value: 10 }, { value: 42 }] },
        { name: "post_clicks", values: [] }, { name: "post_total_media_view_unique", values: [{ value: "n/a" }] }, { name: 7 }, null
      ]
    });
    expect(parsed.get("post_media_view")).toBe(42);
    expect(parsePostInsights({ data: [{ name: "post_clicks", values: [{ value: { like: 1 } }] }] }).get("post_clicks")).toBeNull();
    expect(parsed.get("post_clicks")).toBeNull();
    expect(parsed.get("post_total_media_view_unique")).toBeNull();
    expect(parsePostInsights(null).size).toBe(0);
  });

  it("turns a number into a value, and nothing into nothing", () => {
    expect(postValue(12)).toEqual({ total: 12 });
    expect(postValue(0)).toEqual({ total: 0 });
    expect(postValue(null)).toBeNull();
    expect(postValue(undefined)).toBeNull();
  });

  it("formats a length of time in at most two units, in Vietnamese", () => {
    expect(formatDuration(12_500)).toBe("12,5 giây");
    expect(formatDuration(0)).toBe("0 giây");
    expect(formatDuration(59_940)).toBe("59,9 giây");
    expect(formatDuration(59_960)).toBe("1 phút");
    expect(formatDuration(205_000)).toBe("3 phút 25 giây");
    expect(formatDuration(180_000)).toBe("3 phút");
    expect(formatDuration(3_725_000)).toBe("1 giờ 2 phút");
    expect(formatDuration(7_200_000)).toBe("2 giờ");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("picks the metrics by kind of post, and none of them is from the retired families", () => {
    expect(metricsFor("post")).toBe(POST_METRICS);
    expect(metricsFor("video")).toBe(VIDEO_METRICS);
    expect(metricsFor("reel")).toBe(REEL_METRICS);
    for (const def of [...VIDEO_METRICS, ...REEL_METRICS]) expect(def.graph).not.toMatch(/impressions|fans/);
    expect(new Set(REEL_METRICS.map((m) => m.key)).size).toBe(REEL_METRICS.length);
  });

  it("covers three metrics, none of the retired impressions family, and not the reactions (they have their own section, read live)", () => {
    expect(GRAPH).toEqual(["post_media_view", "post_total_media_view_unique", "post_clicks"]);
    for (const name of GRAPH) expect(name).not.toMatch(/impressions|fans/);
  });
});

const answer = (names: string[], over: Record<string, unknown> = {}) => ({
  data: names.map((name) => ({
    name, period: "lifetime",
    values: [{ value: 100 }]
  })).map((entry) => (name_in(over, entry.name) ? { ...entry, ...(over[entry.name] as object) } : entry))
});
const name_in = (o: Record<string, unknown>, name: string) => Object.prototype.hasOwnProperty.call(o, name);
const invalidMetric = () => new MetaApiError("(#100) The value must be a valid insights metric", "100", 400);
const calls = () => metaGet.mock.calls.map((c) => ({ path: c[0] as string, token: c[1] as string, params: c[2] as Record<string, string> }));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e);

function seed(opts: { scopes?: string[]; page?: Record<string, unknown>; post?: Record<string, unknown>; feed?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: opts.scopes ?? SCOPES });
  fake.tables.facebook_pages.push({
    id: PAGE, user_id: "u1", page_id: "fb-page-1", page_name: "HTStudio", connection_id: CONNECTION, page_access_token_encrypted: "enc",
    tasks: ["CREATE_CONTENT", "ANALYZE"], is_active: true, removed_at: null, ...opts.page
  });
  fake.tables.posts.push({ id: POST, user_id: "u1", page_id: PAGE, status: "published", post_type: "photo", facebook_post_id: FB_POST, facebook_deleted_at: null, ...opts.post });
  fake.tables.page_feed_posts.push({ id: FEED, user_id: "u1", page_id: PAGE, facebook_post_id: FB_POST, status_type: "added_photos", missing_since: null, post_id: null, ...opts.feed });
}

beforeEach(() => {
  metaGet.mockReset(); deactivatePage.mockReset(); requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  clearInsightsCache(); clearPostInsightsCache(); clearVideoLookupCache();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadPostInsights", () => {
  it("asks for the four metrics at once, lifetime, with the Page's token, for the app's post and for a post read from the Fanpage", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(",")));
    const result = await loadPostInsights("u1", { kind: "app", id: POST });
    expect(calls()).toEqual([{ path: `${FB_POST}/insights`, token: "token-of-enc", params: { metric: GRAPH.join(","), period: "lifetime" } }]);
    expect(result.metrics.map((m) => [m.key, m.state])).toEqual([["mediaViews", "ok"], ["viewers", "ok"], ["clicks", "ok"]]);
    expect(result.metrics[0].value).toEqual({ total: 100 });

    clearPostInsightsCache();
    metaGet.mockClear();
    expect((await loadPostInsights("u1", { kind: "feed", id: FEED })).metrics).toHaveLength(3);
    expect(calls()[0].path).toBe(`${FB_POST}/insights`);
  });

  it("one retired metric does not take the others down, and says why in our own words", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.includes("post_clicks")) throw invalidMetric();
      return answer(names);
    });
    const result = await loadPostInsights("u1", { kind: "app", id: POST });
    expect(result.metrics.find((m) => m.key === "clicks")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_UNSUPPORTED", message: ERROR_MESSAGES.INSIGHTS_METRIC_UNSUPPORTED });
    expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("valid insights metric");
  });

  it("remembers the refused metric and the numbers it read", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.includes("post_clicks")) throw invalidMetric();
      return answer(names);
    });
    await loadPostInsights("u1", { kind: "app", id: POST });
    const before = metaGet.mock.calls.length;
    await loadPostInsights("u1", { kind: "app", id: POST });
    expect(metaGet.mock.calls.length).toBe(before);
  });

  it("a metric Facebook leaves out, or gives no value for, says there is no data yet", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const body = answer(params.metric.split(","));
      body.data = body.data.filter((d) => d.name !== "post_media_view");
      body.data.find((d) => d.name === "post_clicks")!.values = [];
      return body;
    });
    const result = await loadPostInsights("u1", { kind: "app", id: POST });
    for (const key of ["mediaViews", "clicks"]) {
      // Worded for a post: there is no date range on a post card.
      expect(result.metrics.find((m) => m.key === key)).toMatchObject({ state: "problem", code: "INSIGHTS_POST_NO_DATA", message: ERROR_MESSAGES.INSIGHTS_POST_NO_DATA });
    }
    expect(ERROR_MESSAGES.INSIGHTS_POST_NO_DATA).not.toMatch(/khoảng ngày/);
  });

  it("what Facebook had no number for is asked again after a few minutes, not kept for half an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let ready = false;
      metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
        const body = answer(params.metric.split(","));
        if (!ready) body.data = body.data.filter((d) => d.name !== "post_media_view");
        return body;
      });
      const views = async () => (await loadPostInsights("u1", { kind: "app", id: POST })).metrics.find((m) => m.key === "mediaViews");
      expect(await views()).toMatchObject({ state: "problem" });
      ready = true;
      vi.setSystemTime(Date.now() + 60_000);
      expect(await views()).toMatchObject({ state: "problem" });           // still within the short memory: no new call
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect(await views()).toMatchObject({ state: "ok" });                 // asked again
    } finally { vi.useRealTimers(); }
  });

  it("a post that lacks a metric does not make the metric 'unsupported' for other posts", async () => {
    const other = "55555555-5555-4555-8555-555555555555";
    fake.tables.posts.push({ id: other, user_id: "u1", page_id: PAGE, status: "published", post_type: "photo", facebook_post_id: "999_888", facebook_deleted_at: null });
    metaGet.mockImplementation(async (path: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (path.startsWith(FB_POST) && names.includes("post_clicks")) throw invalidMetric(); // only THIS post refuses it
      return answer(names);
    });
    await loadPostInsights("u1", { kind: "app", id: POST });
    const second = await loadPostInsights("u1", { kind: "app", id: other });
    expect(second.metrics.every((m) => m.state === "ok")).toBe(true);
  });

  it("a post deleted on Facebook meanwhile is said to be gone, not 'reconnect Facebook'", async () => {
    for (const refusal of [
      new MetaApiError("Unsupported get request", "100", 400, { subcode: "33" }),
      new MetaApiError("(#10) Object does not exist, cannot be loaded due to missing permission or review", "10", 403)
    ]) {
      clearPostInsightsCache();
      metaGet.mockReset(); metaGet.mockRejectedValue(refusal);
      const error = await failure(loadPostInsights("u1", { kind: "app", id: POST }));
      expect(error).toMatchObject({ code: "INSIGHTS_POST_UNAVAILABLE" });
      expect(metaGet).toHaveBeenCalledTimes(1);
    }
    // also when only a single metric is refused that way
    clearPostInsightsCache();
    metaGet.mockReset();
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      if (params.metric.includes(",")) throw new MetaApiError("(#100) odd", "100", 400);
      throw new MetaApiError("Unsupported get request", "100", 400, { subcode: "33" });
    });
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "INSIGHTS_POST_UNAVAILABLE" });
  });

  it("explains a post that has no Insights: not published, deleted on Facebook, or no Facebook id", async () => {
    for (const [post, code] of [
      [{ status: "draft" }, "INSIGHTS_POST_UNAVAILABLE"], [{ facebook_deleted_at: "2026-10-01T00:00:00Z" }, "INSIGHTS_POST_UNAVAILABLE"],
      [{ facebook_post_id: null }, "INSIGHTS_POST_UNAVAILABLE"]
    ] as const) {
      seed({ post });
      expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code });
    }
    seed({ feed: { missing_since: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadPostInsights("u1", { kind: "feed", id: FEED }))).toMatchObject({ code: "INSIGHTS_POST_UNAVAILABLE" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("reads a video with its own numbers (views, watch time) and a Reel with the plays of the Reel on top", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(",")));
    seed({ post: { post_type: "video" } });
    const video = await loadPostInsights("u1", { kind: "app", id: POST });
    expect(video.variant).toBe("video");
    expect(calls()[0].params.metric).toBe(VIDEO_METRICS.map((m) => m.graph).join(","));
    expect(video.metrics.map((m) => m.key)).toEqual(["mediaViews", "viewers", "videoViews", "watchTime", "avgWatch"]);
    expect(video.metrics.find((m) => m.key === "watchTime")).toMatchObject({ state: "ok", format: "duration", value: { total: 100 } });
    expect(JSON.stringify(video)).not.toContain("post_clicks");

    clearPostInsightsCache(); metaGet.mockClear();
    seed({ post: { post_type: "reel" } });
    const reel = await loadPostInsights("u1", { kind: "app", id: POST });
    expect(reel.variant).toBe("reel");
    expect(reel.metrics.map((m) => m.key)).toEqual(["mediaViews", "viewers", "videoViews", "watchTime", "avgWatch", "reelsPlays"]);
    expect(calls()[0].params.metric).toContain("blue_reels_play_count");

    clearPostInsightsCache(); metaGet.mockClear();
    seed({ feed: { status_type: "added_video" } });
    expect((await loadPostInsights("u1", { kind: "feed", id: FEED })).variant).toBe("video");
  });

  describe("a video made in the app is known by its video id", () => {
    const VIDEO = "998877665544";
    const POST_OF_VIDEO = "1171329916068581_555000111";
    const insightsCalls = () => calls().filter((c) => c.path.endsWith("/insights"));
    const lookupCalls = () => calls().filter((c) => c.params.fields === "post_id");
    const facebook = (lookup: () => unknown) => metaGet.mockImplementation(async (path: string, _t: string, params: Record<string, string>) => {
      if (params.fields === "post_id") return lookup();
      return answer(params.metric.split(","));
    });

    it("asks Facebook which post shows the video, once, and reads the numbers of that post", async () => {
      seed({ post: { post_type: "video", facebook_post_id: VIDEO } });
      facebook(() => ({ post_id: POST_OF_VIDEO, id: VIDEO }));
      const result = await loadPostInsights("u1", { kind: "app", id: POST });
      expect(lookupCalls()).toHaveLength(1);
      expect(lookupCalls()[0].path).toBe(VIDEO);
      expect(insightsCalls().map((c) => c.path)).toEqual([`${POST_OF_VIDEO}/insights`]);
      expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(5);
      clearPostInsightsCache(); metaGet.mockClear();
      await loadPostInsights("u1", { kind: "app", id: POST });
      expect(lookupCalls()).toHaveLength(0); // remembered
      expect(insightsCalls()[0].path).toBe(`${POST_OF_VIDEO}/insights`);
    });

    it("uses the video id as it is when Facebook will not say, and does not ask again for a while", async () => {
      seed({ post: { post_type: "reel", facebook_post_id: VIDEO } });
      facebook(() => { throw new MetaApiError("(#100) Tried accessing nonexisting field (post_id)", "100", 400); });
      const result = await loadPostInsights("u1", { kind: "app", id: POST });
      expect(insightsCalls().map((c) => c.path)).toEqual([`${VIDEO}/insights`]);
      expect(result.variant).toBe("reel");
      clearPostInsightsCache(); metaGet.mockClear();
      await loadPostInsights("u1", { kind: "app", id: POST });
      expect(lookupCalls()).toHaveLength(0);
    });

    it("does not look up anything for a post id, or a plain post", async () => {
      seed({ post: { post_type: "video" } });
      facebook(() => ({}));
      await loadPostInsights("u1", { kind: "app", id: POST });
      seed();
      clearPostInsightsCache();
      await loadPostInsights("u1", { kind: "app", id: POST });
      expect(lookupCalls()).toHaveLength(0);
    });

    it("a video node that does not offer a metric (unsupported get request) is told per metric, never as a deleted video", async () => {
      seed({ post: { post_type: "video" } });
      metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
        const names = params.metric.split(",");
        if (names.length > 1 || names[0] === "post_video_view_time") throw new MetaApiError("Unsupported get request", "100", 400, { subcode: "33" });
        return answer(names);
      });
      const result = await loadPostInsights("u1", { kind: "app", id: POST });
      expect(result.metrics.find((m) => m.key === "watchTime")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_UNSUPPORTED" });
      expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(4);
    });

    it("a permission answer for one metric alone does not hide the numbers that arrived", async () => {
      seed({ post: { post_type: "reel" } });
      metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
        const names = params.metric.split(",");
        if (names.length > 1) throw new MetaApiError("(#100) Invalid parameter", "100", 400);
        if (names[0] === "blue_reels_play_count") throw new MetaApiError("(#200) denied", "200", 403);
        return answer(names);
      });
      const result = await loadPostInsights("u1", { kind: "app", id: POST });
      expect(result.metrics.find((m) => m.key === "reelsPlays")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_FAILED" });
      expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(5);
    });
  });

  it("a video metric Facebook does not offer is reported for that metric only", async () => {
    seed({ post: { post_type: "reel" } });
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.includes("blue_reels_play_count")) throw invalidMetric();
      return answer(names);
    });
    const reel = await loadPostInsights("u1", { kind: "app", id: POST });
    expect(reel.metrics.find((m) => m.key === "reelsPlays")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_UNSUPPORTED" });
    expect(reel.metrics.filter((m) => m.state === "ok")).toHaveLength(5);
  });

  it("does not show another user's post, or one that does not exist", async () => {
    expect(await failure(loadPostInsights("someone-else", { kind: "app", id: POST }))).toMatchObject({ code: "POST_NOT_FOUND" });
    expect(await failure(loadPostInsights("u1", { kind: "feed", id: "99999999-9999-4999-8999-999999999999" }))).toMatchObject({ code: "POST_NOT_FOUND" });
  });

  it("says what is missing for the Page: permission, Analyze task, removed or switched off", async () => {
    seed({ scopes: ["pages_show_list", "pages_manage_posts"] });
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "INSIGHTS_SCOPES_MISSING" });
    seed({ page: { tasks: ["CREATE_CONTENT"] } });
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "INSIGHTS_NO_ANALYZE" });
    seed({ page: { removed_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_REMOVED_ACTION" });
    seed({ page: { is_active: false } });
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_INACTIVE" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("Facebook refusing the Page, a dead token and a rate limit each have their own message", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#10) Requires read_insights", "10", 403));
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "INSIGHTS_PERMISSION_DENIED" });
    expect(metaGet).toHaveBeenCalledTimes(1); // no metric-by-metric retries for a refused Page

    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("Error validating access token", "190", 400));
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "PAGE_PERMISSION_LOST" });
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);

    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("limit", "4", 400));
    expect(await failure(loadPostInsights("u1", { kind: "app", id: POST }))).toMatchObject({ code: "FB_RATE_LIMITED" });
  });
});

describe("GET /api/posts/[id]/insights", () => {
  const get = (id: string, query: string) => GET(new NextRequest(`http://localhost/api/posts/${id}/insights?${query}`), { params: Promise.resolve({ id }) });

  it("needs a signed-in user and a valid post and kind", async () => {
    requireUser.mockResolvedValue(null);
    expect((await get(POST, "kind=app")).status).toBe(401);
    requireUser.mockResolvedValue({ id: "u1" });
    expect((await get(POST, "kind=other")).status).toBe(404);
    expect((await get("not-a-uuid", "kind=app")).status).toBe(404);
    expect((await get("99999999-9999-4999-8999-999999999999", "kind=app")).status).toBe(404);
  });

  it("answers with the cards, uncached", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(",")));
    const res = await get(POST, "kind=app");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).metrics).toHaveLength(3);
  });

  it("failures come as our own wording with the right status, never Facebook's text", async () => {
    metaGet.mockRejectedValue(new MetaApiError("SECRET raw text from Facebook (#10)", "10", 403));
    const res = await get(POST, "kind=app");
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ code: "INSIGHTS_PERMISSION_DENIED", error: ERROR_MESSAGES.INSIGHTS_PERMISSION_DENIED });
    expect(JSON.stringify(body)).not.toContain("SECRET");

    seed({ post: { status: "draft" } });
    const notLive = await get(POST, "kind=app");
    expect(notLive.status).toBe(409);
    expect((await notLive.json()).code).toBe("INSIGHTS_POST_UNAVAILABLE");
  });
});
