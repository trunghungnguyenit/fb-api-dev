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
  ...(await original<typeof import("@/lib/meta/client")>()),
  metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { GET } from "@/app/api/insights/route";
import { clearInsightsCache, loadInsights } from "@/lib/insights";
import { MetaApiError } from "@/lib/meta/client";
import { INSIGHT_METRICS, resolveRange, type DateRange } from "@/lib/meta/insights";
import { ERROR_MESSAGES } from "@/lib/errors";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-25T05:00:00Z");
const SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights"];
const GRAPH_NAMES = INSIGHT_METRICS.map((m) => m.graph);

const RANGE = (() => { const r = resolveRange({ range: "7d" }, NOW); if (!r.ok) throw new Error("range"); return r.range; })() as DateRange;

/** Graph's answer for a metric: one value per day of `range` (end_time = end of the day). */
function answer(names: string[], values: (day: number) => number | null = (i) => (i + 1) * 10, days = 7, startDay = "2026-10-18") {
  return {
    data: names.map((name) => ({
      name, period: "day",
      values: Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.parse(`${startDay}T00:00:00Z`) + (i + 1) * 86_400_000);
        return { value: values(i), end_time: `${d.toISOString().slice(0, 10)}T07:00:00+0000` };
      })
    }))
  };
}
const invalidMetric = () => new MetaApiError("(#100) The value must be a valid insights metric", "100", 400);

function seed(opts: { scopes?: string[]; page?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: opts.scopes ?? SCOPES });
  fake.tables.facebook_pages.push({
    id: PAGE, user_id: "u1", page_id: "fb-page-1", page_name: "HTStudio", connection_id: CONNECTION, page_access_token_encrypted: "enc",
    tasks: ["CREATE_CONTENT", "ANALYZE"], is_active: true, removed_at: null, ...opts.page
  });
}
const calls = () => metaGet.mock.calls.map((c) => ({ path: c[0] as string, token: c[1] as string, params: c[2] as Record<string, string> }));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e);

beforeEach(() => {
  metaGet.mockReset(); deactivatePage.mockReset(); requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  clearInsightsCache();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadInsights", () => {
  it("asks for all six metrics at once with the Page's own token, and compares with the period before", async () => {
    // Each request is answered for the days it asked about.
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(","), (i) => (i + 1) * 10, 7, params.since));
    const result = await loadInsights("u1", PAGE, RANGE, NOW);

    const sent = calls();
    expect(sent).toHaveLength(2); // this range and the previous one, one request each
    expect(sent[0]).toMatchObject({ path: "fb-page-1/insights", token: "token-of-enc" });
    expect(sent[0].params).toEqual({ metric: GRAPH_NAMES.join(","), period: "day", since: "2026-10-18", until: "2026-10-25" });
    expect(sent[1].params).toMatchObject({ since: "2026-10-11", until: "2026-10-18" });

    expect(result.page).toEqual({ id: PAGE, name: "HTStudio" });
    expect(result.previous).toMatchObject({ start: "2026-10-11", end: "2026-10-17" });
    expect(result.metrics.map((m) => [m.key, m.state])).toEqual(INSIGHT_METRICS.map((m) => [m.key, "ok"]));
    const views = result.metrics[0];
    expect(views.value).toBe(10 + 20 + 30 + 40 + 50 + 60 + 70); // total of the 7 days
    expect(views.previousValue).toBe(280);
    expect(views.series).toHaveLength(7);
    const followers = result.metrics.find((m) => m.key === "followers")!;
    expect(followers.value).toBe(70); // a running total shows its last day
    expect(followers.delta).toBe(60);
  });

  it("one retired metric does not take the page down: the others still show, and the refused one says why", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.includes("page_follows")) throw invalidMetric();
      return answer(names);
    });
    const result = await loadInsights("u1", PAGE, RANGE, NOW);

    const followers = result.metrics.find((m) => m.key === "followers")!;
    expect(followers).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_UNSUPPORTED", message: ERROR_MESSAGES.INSIGHTS_METRIC_UNSUPPORTED });
    expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(5);
    // Facebook's own wording is never passed on.
    expect(JSON.stringify(result)).not.toContain("valid insights metric");
  });

  it("remembers a metric Facebook refused, so the next look does not ask again", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.includes("page_follows")) throw invalidMetric();
      return answer(names);
    });
    await loadInsights("u1", PAGE, RANGE, NOW);
    metaGet.mockClear();
    const other = { ...RANGE, start: "2026-10-17", end: "2026-10-23" }; // a range not in the cache
    const result = await loadInsights("u1", PAGE, other, NOW);
    for (const c of calls()) expect(c.params.metric).not.toContain("page_follows");
    expect(result.metrics.find((m) => m.key === "followers")?.code).toBe("INSIGHTS_METRIC_UNSUPPORTED");
  });

  it("when Facebook refuses every metric the page still loads, each card with its reason", async () => {
    metaGet.mockRejectedValue(invalidMetric());
    const result = await loadInsights("u1", PAGE, RANGE, NOW);
    expect(result.metrics.every((m) => m.state === "problem" && m.code === "INSIGHTS_METRIC_UNSUPPORTED")).toBe(true);
    expect(result.previous).toBeNull();
  });

  it("a metric with no values (or only empty ones) says there is no data yet, not that it is broken", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      const body = answer(names);
      body.data = body.data.filter((d) => d.name !== "page_media_view");               // absent from the answer
      body.data.find((d) => d.name === "page_follows")!.values.forEach((v) => { (v as { value: number | null }).value = null; }); // all empty
      return body;
    });
    const result = await loadInsights("u1", PAGE, RANGE, NOW);
    for (const key of ["mediaViews", "followers"]) {
      expect(result.metrics.find((m) => m.key === key)).toMatchObject({ state: "problem", code: "INSIGHTS_NO_DATA", message: ERROR_MESSAGES.INSIGHTS_NO_DATA });
    }
    expect(result.metrics.find((m) => m.key === "viewers")?.state).toBe("ok");
  });

  it("a metric that fails for another reason is reported as failed, on its own", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      const names = params.metric.split(",");
      if (names.length > 1) throw new MetaApiError("(#100) Something odd happened", "100", 400);
      if (names[0] === "page_post_engagements") throw new MetaApiError("(#100) Something odd happened", "100", 400);
      return answer(names);
    });
    const result = await loadInsights("u1", PAGE, RANGE, NOW);
    expect(result.metrics.find((m) => m.key === "engagements")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_FAILED" });
    expect(result.metrics.filter((m) => m.state === "ok")).toHaveLength(5);
  });

  it("without a comparison period the cards simply show no change", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
      if (params.since === "2026-10-11") throw new MetaApiError("rate", "4", 400);
      return answer(params.metric.split(","));
    });
    const result = await loadInsights("u1", PAGE, RANGE, NOW);
    expect(result.previous).toBeNull();
    expect(result.metrics[0]).toMatchObject({ state: "ok", previousValue: null, changePct: null, tone: "flat" });
  });

  it("keeps what it read for a while", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(",")));
    await loadInsights("u1", PAGE, RANGE, NOW);
    const before = metaGet.mock.calls.length;
    await loadInsights("u1", PAGE, RANGE, NOW);
    expect(metaGet.mock.calls.length).toBe(before);
  });
});

describe("what the user is told when it cannot be read", () => {
  it("no read_insights permission: says so and does not call Facebook", async () => {
    seed({ scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"] });
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "INSIGHTS_SCOPES_MISSING" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("no Analyze task on the Page: says so and does not call Facebook; an old row with no tasks is not judged", async () => {
    seed({ page: { tasks: ["CREATE_CONTENT", "MANAGE"] } });
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "INSIGHTS_NO_ANALYZE" });
    expect(metaGet).not.toHaveBeenCalled();

    seed({ page: { tasks: [] } });
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(",")));
    expect((await loadInsights("u1", PAGE, RANGE, NOW)).metrics[0].state).toBe("ok");
  });

  it("a removed or switched-off Fanpage, or someone else's", async () => {
    seed({ page: { removed_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "PAGE_REMOVED_ACTION" });
    seed({ page: { is_active: false } });
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "PAGE_INACTIVE" });
    seed();
    expect(await failure(loadInsights("someone-else", PAGE, RANGE, NOW))).toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("Facebook refusing the Page itself (permission): one clear message, no metric-by-metric retries", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#10) Requires read_insights", "10", 403));
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "INSIGHTS_PERMISSION_DENIED" });
    expect(metaGet).toHaveBeenCalledTimes(1);
    expect(deactivatePage).not.toHaveBeenCalled();
  });

  it("a dead token switches the Page off like everywhere else", async () => {
    metaGet.mockRejectedValue(new MetaApiError("Error validating access token", "190", 400));
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "PAGE_PERMISSION_LOST" });
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);
  });

  it("rate limit and outages have their own messages", async () => {
    metaGet.mockRejectedValue(new MetaApiError("Application request limit reached", "4", 400));
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "FB_RATE_LIMITED" });
    metaGet.mockReset();
    metaGet.mockRejectedValue(new Error("socket hang up"));
    expect(await failure(loadInsights("u1", PAGE, RANGE, NOW))).toMatchObject({ code: "FB_UNAVAILABLE" });
  });
});

describe("GET /api/insights", () => {
  const get = (query: string) => GET(new NextRequest(`http://localhost/api/insights?${query}`));

  it("needs a signed-in user", async () => {
    requireUser.mockResolvedValue(null);
    expect((await get(`page=${PAGE}`)).status).toBe(401);
  });

  it("names the wrong field of a bad range instead of a generic message", async () => {
    const res = await get(`page=${PAGE}&range=custom&since=2026-01-01&until=2026-10-01`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.fields.until).toMatch(/tối đa 93 ngày/);
    expect(body.error).toMatch(/tối đa 93 ngày/);
    expect(body.ref).toBeTruthy();
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("answers with the cards, uncached", async () => {
    metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => answer(params.metric.split(","), (i) => i, 28, "2026-09-26"));
    const res = await get(`page=${PAGE}&range=28d`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).metrics).toHaveLength(6);
  });

  it("failures come as our own wording and the right status, never Facebook's text", async () => {
    metaGet.mockRejectedValue(new MetaApiError("SECRET raw text from Facebook (#10)", "10", 403));
    const res = await get(`page=${PAGE}`);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("INSIGHTS_PERMISSION_DENIED");
    expect(body.error).toBe(ERROR_MESSAGES.INSIGHTS_PERMISSION_DENIED);
    expect(JSON.stringify(body)).not.toContain("SECRET");

    seed({ scopes: ["pages_show_list"] });
    const missing = await get(`page=${PAGE}`);
    expect(missing.status).toBe(403);
    expect((await missing.json()).code).toBe("INSIGHTS_SCOPES_MISSING");
  });

  it("an unknown Fanpage is a 404", async () => {
    expect((await get("page=22222222-2222-4222-8222-222222222222")).status).toBe(404);
    expect((await get("page=not-a-uuid")).status).toBe(404);
  });
});
