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

import { GET } from "@/app/api/insights/demographics/route";
import { clearDemographicsCache, loadDemographics } from "@/lib/demographics";
import { ERROR_MESSAGES } from "@/lib/errors";
import { clearInsightsCache } from "@/lib/insights";
import { MetaApiError } from "@/lib/meta/client";
import { buildRows, countryName, DEMOGRAPHICS, genderAgeLabel, parseBreakdown } from "@/lib/meta/demographics";

const PAGE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights"];

const answer = (graph: string, value: unknown) => ({ data: [{ name: graph, period: "day", values: [{ value: {}, end_time: "2026-10-24T07:00:00+0000" }, { value, end_time: "2026-10-25T07:00:00+0000" }] }] });
const BODIES: Record<string, unknown> = {
  page_follows_country: { VN: 900, US: 60, JP: 40 },
  page_follows_city: { "Hanoi, Vietnam": 500, "Ho Chi Minh City, Vietnam": 300 },
  page_follows_gender_age: { "F.25-34": 400, "M.25-34": 300, "U.18-24": 5 }
};
const facebook = (over: Record<string, unknown> = {}) => metaGet.mockImplementation(async (_p: string, _t: string, params: Record<string, string>) => {
  const graph = params.metric;
  const value = graph in over ? over[graph] : BODIES[graph];
  if (value instanceof Error) throw value;
  return answer(graph, value);
});
const calls = () => metaGet.mock.calls.map((c) => ({ path: c[0] as string, token: c[1] as string, params: c[2] as Record<string, string> }));
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e);
const invalidMetric = () => new MetaApiError("(#100) The value must be a valid insights metric", "100", 400);

function seed(opts: { scopes?: string[]; page?: Record<string, unknown> } = {}) {
  fake.reset();
  fake.tables.facebook_connections.push({ id: CONNECTION, user_id: "u1", scopes: opts.scopes ?? SCOPES });
  fake.tables.facebook_pages.push({
    id: PAGE, user_id: "u1", page_id: "fb-page-1", page_name: "HTStudio", connection_id: CONNECTION, page_access_token_encrypted: "enc",
    tasks: ["CREATE_CONTENT", "ANALYZE"], is_active: true, removed_at: null, ...opts.page
  });
}

beforeEach(() => {
  metaGet.mockReset(); deactivatePage.mockReset(); requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "u1" });
  clearInsightsCache(); clearDemographicsCache();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reading Facebook's answer (pure)", () => {
  it("takes the newest value that has numbers in it, and nothing when there are none", () => {
    expect(parseBreakdown(answer("m", { A: 3, B: 1 }), "m")).toEqual({ A: 3, B: 1 });
    expect(parseBreakdown({ data: [{ name: "m", values: [{ value: { A: 1 } }, { value: {} }] }] }, "m")).toEqual({ A: 1 });
    expect(parseBreakdown({ data: [{ name: "m", values: [{ value: {} }] }] }, "m")).toBeNull();
    expect(parseBreakdown({ data: [{ name: "m", values: [{ value: { A: "x", B: -1 } }] }] }, "m")).toBeNull();
    expect(parseBreakdown({ data: [{ name: "other", values: [{ value: { A: 1 } }] }] }, "m")).toBeNull();
    for (const bad of [null, {}, { data: "x" }, { data: [{ name: "m", values: 5 }] }, { data: [{ name: "m", values: [{ value: [1] }] }] }]) expect(parseBreakdown(bad, "m")).toBeNull();
  });

  it("names countries in Vietnamese and gender and age readably, and keeps what it does not know", () => {
    expect(countryName("VN")).toBe("Việt Nam");
    expect(countryName("zz-not-a-country")).toBe("zz-not-a-country");
    expect(genderAgeLabel("F.25-34")).toBe("Nữ, 25–34 tuổi");
    expect(genderAgeLabel("M.65+")).toBe("Nam, 65+ tuổi");
    expect(genderAgeLabel("U.13-17")).toBe("Không rõ giới tính, 13–17 tuổi");
    expect(genderAgeLabel("weird")).toBe("weird");
  });

  it("lists the biggest groups first with their share, adds the rest up, and has nothing for an empty block", () => {
    const raw: Record<string, number> = { a: 50, b: 30, c: 10, d: 5, e: 5, zero: 0 };
    const block = buildRows(raw, "cities", 3);
    expect(block?.total).toBe(100);
    expect(block?.rows.map((r) => [r.key, r.value, r.share])).toEqual([["a", 50, 0.5], ["b", 30, 0.3], ["c", 10, 0.1]]);
    expect(block?.others).toBe(10);
    expect(buildRows({ x: 1, y: 1 }, "cities")?.rows.map((r) => r.key)).toEqual(["x", "y"]);
    expect(buildRows({ VN: 3 }, "countries")?.rows[0].label).toBe("Việt Nam");
    expect(buildRows({}, "cities")).toBeNull();
    expect(buildRows({ x: 0 }, "cities")).toBeNull();
  });

  it("asks for three breakdowns, none of the retired fans family", () => {
    expect(DEMOGRAPHICS.map((d) => d.graph)).toEqual(["page_follows_country", "page_follows_city", "page_follows_gender_age"]);
    for (const d of DEMOGRAPHICS) expect(d.graph).not.toMatch(/fans/);
  });
});

describe("loadDemographics", () => {
  it("reads the three breakdowns, one request each with the Page's token, and shows the biggest first", async () => {
    facebook();
    const result = await loadDemographics("u1", PAGE);
    expect(calls()).toEqual(DEMOGRAPHICS.map((d) => ({ path: "fb-page-1/insights", token: "token-of-enc", params: { metric: d.graph, period: "day" } })));
    expect(result.page).toEqual({ id: PAGE, name: "HTStudio" });
    expect(result.blocks.map((b) => [b.key, b.state])).toEqual([["countries", "ok"], ["cities", "ok"], ["genderAge", "ok"]]);
    expect(result.blocks[0].block?.rows.map((r) => [r.label, r.value])).toEqual([["Việt Nam", 900], ["Hoa Kỳ", 60], ["Nhật Bản", 40]]);
    expect(result.blocks[2].block?.rows[0].label).toBe("Nữ, 25–34 tuổi");
  });

  it("one retired breakdown does not take the others down, and says why in our own words", async () => {
    facebook({ page_follows_gender_age: invalidMetric() });
    const result = await loadDemographics("u1", PAGE);
    expect(result.blocks.find((b) => b.key === "genderAge")).toMatchObject({ state: "problem", code: "INSIGHTS_METRIC_UNSUPPORTED", message: ERROR_MESSAGES.INSIGHTS_METRIC_UNSUPPORTED });
    expect(result.blocks.filter((b) => b.state === "ok")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("valid insights metric");
  });

  it("says Facebook has nothing yet when it answers with no numbers (too few followers)", async () => {
    facebook({ page_follows_city: {} });
    const result = await loadDemographics("u1", PAGE);
    expect(result.blocks.find((b) => b.key === "cities")).toMatchObject({ state: "problem", code: "DEMOGRAPHICS_NO_DATA" });
  });

  it("remembers what it read, and a refused breakdown only briefly", async () => {
    facebook();
    await loadDemographics("u1", PAGE);
    await loadDemographics("u1", PAGE);
    expect(metaGet).toHaveBeenCalledTimes(3);
    clearDemographicsCache(); metaGet.mockClear();
    facebook({ page_follows_city: {} });
    await loadDemographics("u1", PAGE);
    facebook();
    await loadDemographics("u1", PAGE); // the empty answer is still remembered: no new call for it
    expect(calls().filter((c) => c.params.metric === "page_follows_city")).toHaveLength(1);
    expect((await loadDemographics("u1", PAGE)).blocks.find((b) => b.key === "cities")?.state).toBe("problem");
  });

  it("says what is missing for the Page without asking Facebook: permission, Analyze task, removed or off, another user's", async () => {
    seed({ scopes: ["pages_show_list", "pages_manage_posts"] });
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "INSIGHTS_SCOPES_MISSING" });
    seed({ page: { tasks: ["CREATE_CONTENT"] } });
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "INSIGHTS_NO_ANALYZE" });
    seed({ page: { removed_at: "2026-10-01T00:00:00Z" } });
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "PAGE_REMOVED_ACTION" });
    seed({ page: { is_active: false } });
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "PAGE_INACTIVE" });
    seed();
    expect(await failure(loadDemographics("someone-else", PAGE))).toMatchObject({ code: "PAGE_NOT_FOUND" });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("a refused Page, a dead token and a rate limit stop the read, each with its own message", async () => {
    metaGet.mockRejectedValue(new MetaApiError("(#10) Requires read_insights", "10", 403));
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "INSIGHTS_PERMISSION_DENIED" });
    expect(metaGet).toHaveBeenCalledTimes(1);
    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("Error validating access token", "190", 400));
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "PAGE_PERMISSION_LOST" });
    expect(deactivatePage).toHaveBeenCalledWith("u1", PAGE);
    metaGet.mockReset(); metaGet.mockRejectedValue(new MetaApiError("limit", "4", 400));
    expect(await failure(loadDemographics("u1", PAGE))).toMatchObject({ code: "FB_RATE_LIMITED" });
  });
});

describe("GET /api/insights/demographics", () => {
  const get = (query: string) => GET(new NextRequest(`http://localhost/api/insights/demographics?${query}`));

  it("needs a signed-in user and a valid Fanpage", async () => {
    requireUser.mockResolvedValue(null);
    expect((await get(`page=${PAGE}`)).status).toBe(401);
    requireUser.mockResolvedValue({ id: "u1" });
    expect((await get("page=not-a-uuid")).status).toBe(404);
    expect((await get("")).status).toBe(404);
    expect((await get("page=99999999-9999-4999-8999-999999999999")).status).toBe(404);
  });

  it("answers with the blocks, uncached", async () => {
    facebook();
    const res = await get(`page=${PAGE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).blocks).toHaveLength(3);
  });

  it("failures come as our own wording with the right status, never Facebook's text", async () => {
    metaGet.mockRejectedValue(new MetaApiError("SECRET raw text from Facebook (#10)", "10", 403));
    const res = await get(`page=${PAGE}`);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ code: "INSIGHTS_PERMISSION_DENIED", error: ERROR_MESSAGES.INSIGHTS_PERMISSION_DENIED });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});
