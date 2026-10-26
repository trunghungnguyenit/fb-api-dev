import { one, userDb } from "@/lib/db";
import { type ErrorCode, messageFor } from "@/lib/errors";
import { FacebookActionError, runWithPageToken } from "@/lib/facebook-posts";
import { MetaApiError, MetaRateLimitedError, metaGet } from "@/lib/meta/client";
import {
  type Aggregate, changePercent, changeTone, type DateRange, type DayPoint, fillDays, graphWindow, INSIGHT_METRICS, type MetricDef,
  type MetricKey, mainValue, metricErrorKind, parseInsights, previousRange
} from "@/lib/meta/insights";
import { describeMetaError } from "@/lib/meta/pages";
import { FEATURES, hasScopes } from "@/lib/meta/scopes";

// Reads a Fanpage's Insights from Facebook for the Insights page. Nothing is stored: numbers are asked for when the
// page is opened (and kept in memory for a short while). Every metric is read on its own account, because Meta keeps
// retiring and renaming Page metrics: one that Facebook refuses is reported for that metric, the others still show.

export type MetricResult = {
  key: MetricKey; label: string; hint: string; unit: string; aggregate: Aggregate; goodWhen: "up" | "down";
  state: "ok" | "problem";
  /** state "problem": which of our codes, and its Vietnamese text (Facebook's own wording is never passed on). */
  code?: ErrorCode; message?: string;
  /** state "ok": the number on the card, the same for the previous period, and the change between them. */
  value?: number; previousValue?: number | null; changePct?: number | null; tone?: "good" | "bad" | "flat";
  /** state "ok", metrics that are a running total: how much it moved inside the range. */
  delta?: number | null;
  series?: DayPoint[]; previousSeries?: DayPoint[] | null;
};

export type InsightsResult = {
  page: { id: string; name: string };
  range: DateRange;
  /** The comparison range, or null when Facebook does not keep data that far back (or it could not be read). */
  previous: DateRange | null;
  metrics: MetricResult[];
  fetchedAt: string;
};

// ---- Short memory ------------------------------------------------------------------------------------------------------
// Insights change about once a day, so a repeated look (a reload, switching Fanpage and back) does not need new calls.
const CACHE_MS = 30 * 60_000;
const UNSUPPORTED_MS = 60 * 60_000;
const CACHE_MAX = 400;
const seriesCache = new Map<string, { at: number; points: DayPoint[] }>();
/** Metrics Facebook said it does not know, so the next look does not spend a call finding out again. */
const unsupportedUntil = new Map<string, number>();

export function clearInsightsCache() { seriesCache.clear(); unsupportedUntil.clear(); }

const cacheKey = (userId: string, pageFbId: string, graph: string, range: DateRange) => `${userId}|${pageFbId}|${graph}|${range.start}|${range.end}`;
export const knownUnsupported = (graph: string) => (unsupportedUntil.get(graph) ?? 0) > Date.now();

function remember(key: string, points: DayPoint[]) {
  if (seriesCache.size >= CACHE_MAX) seriesCache.delete(seriesCache.keys().next().value as string);
  seriesCache.set(key, { at: Date.now(), points });
}

// ---- Reading one date range -------------------------------------------------------------------------------------------

type ReadEntry = { points: DayPoint[] } | { problem: ErrorCode };
type Read = Map<MetricKey, ReadEntry>;

/** Errors that stop the whole read (and are explained by the shared Facebook error handling) instead of one metric. */
export function stopsEverything(e: unknown): boolean {
  if (!(e instanceof MetaApiError) || e instanceof MetaRateLimitedError) return true; // timeout, network, unreadable answer, our own back-off
  const code = describeMetaError(e);
  return code === "PAGE_PERMISSION_LOST" || code === "FB_RATE_LIMITED" || code === "FB_TEMP_BLOCKED" || code === "FB_UNAVAILABLE";
}

/**
 * What a refusal of ONE metric (named as in the Graph API) means. Throws when the whole Page is refused or the read cannot go on.
 * `remember: false` for metrics whose support depends on the object asked about (a post), so that one post lacking a metric is
 * never taken as "Facebook dropped it" for everybody: only Page metrics are remembered process-wide.
 */
export function refusalOf(e: unknown, graph: string, opts: { remember?: boolean } = {}): ErrorCode {
  if (stopsEverything(e)) throw e;
  const error = e as MetaApiError;
  const kind = metricErrorKind(error);
  if (kind === "permission") throw new FacebookActionError("INSIGHTS_PERMISSION_DENIED", false, e);
  if (kind === "unsupported") {
    if (opts.remember !== false) unsupportedUntil.set(graph, Date.now() + UNSUPPORTED_MS);
    return "INSIGHTS_METRIC_UNSUPPORTED";
  }
  return "INSIGHTS_METRIC_FAILED";
}
const problemOf = (e: unknown, def: MetricDef) => refusalOf(e, def.graph);

async function ask(token: string, pageFbId: string, graph: string[], range: DateRange) {
  const { since, until } = graphWindow(range);
  return parseInsights(await metaGet(`${pageFbId}/insights`, token, { metric: graph.join(","), period: "day", since, until }));
}

/**
 * Daily values of `defs` for `range`. One request for all of them; if Facebook refuses it (one retired metric makes it
 * refuse the lot) each metric is asked for alone, so only the refused ones are reported.
 */
async function readRange(userId: string, token: string, pageFbId: string, defs: MetricDef[], range: DateRange): Promise<Read> {
  const out: Read = new Map();
  const missing: MetricDef[] = [];
  for (const def of defs) {
    if (knownUnsupported(def.graph)) { out.set(def.key, { problem: "INSIGHTS_METRIC_UNSUPPORTED" }); continue; }
    const hit = seriesCache.get(cacheKey(userId, pageFbId, def.graph, range));
    if (hit && Date.now() - hit.at < CACHE_MS) out.set(def.key, { points: hit.points });
    else missing.push(def);
  }
  if (!missing.length) return out;

  const store = (def: MetricDef, parsed: Map<string, DayPoint[]>) => {
    const raw = parsed.get(def.graph);
    if (!raw) { out.set(def.key, { problem: "INSIGHTS_NO_DATA" }); return; }
    const points = fillDays(raw, range);
    remember(cacheKey(userId, pageFbId, def.graph, range), points);
    out.set(def.key, { points });
  };

  try {
    const parsed = await ask(token, pageFbId, missing.map((d) => d.graph), range);
    for (const def of missing) store(def, parsed);
    return out;
  } catch (e) {
    if (stopsEverything(e)) throw e;
    if (metricErrorKind(e as MetaApiError) === "permission") throw new FacebookActionError("INSIGHTS_PERMISSION_DENIED", false, e);
    console.warn(`insights: the combined request was refused (${(e as MetaApiError).code}); asking metric by metric`, (e as MetaApiError).message);
  }

  for (const def of missing) {
    try { store(def, await ask(token, pageFbId, [def.graph], range)); }
    catch (e) { out.set(def.key, { problem: problemOf(e, def) }); }
  }
  return out;
}

// ---- The page's numbers -----------------------------------------------------------------------------------------------

type PageRow = { id: string; page_id: string; page_name: string; tasks: string[] | null; connection_id: string; is_active: boolean; removed_at: string | null };

/**
 * The user's Fanpage, once everything that can be known without asking Facebook says Insights may be read from it.
 * Throws FacebookActionError: Fanpage unknown / removed / switched off, `read_insights` not granted, no "Analyze" task.
 */
export async function requireInsightsPage(userId: string, pageRowId: string): Promise<PageRow> {
  const db = userDb(userId);
  const { data, error } = await db.pages.select("id,page_id,page_name,tasks,connection_id,is_active,removed_at").eq("id", pageRowId).maybeSingle();
  if (error) throw new FacebookActionError("DB_ERROR", false, error);
  const page = one<PageRow>(data);
  if (!page) throw new FacebookActionError("PAGE_NOT_FOUND");
  if (page.removed_at) throw new FacebookActionError("PAGE_REMOVED_ACTION");
  if (!page.is_active) throw new FacebookActionError("PAGE_INACTIVE");

  const { data: connection, error: connectionError } = await db.connections.select("scopes").eq("id", page.connection_id).maybeSingle();
  if (connectionError) throw new FacebookActionError("DB_ERROR", false, connectionError);
  if (!hasScopes(one<{ scopes: string[] | null }>(connection)?.scopes, FEATURES.insights.scopes)) throw new FacebookActionError("INSIGHTS_SCOPES_MISSING");
  // `tasks` is what Facebook said the user may do on this Page; an old row without it is not judged.
  if (page.tasks?.length && !page.tasks.includes("ANALYZE")) throw new FacebookActionError("INSIGHTS_NO_ANALYZE");
  return page;
}

/**
 * Insights of one of the user's Fanpages for `range`, with the same-length period before it for comparison.
 * Throws FacebookActionError with a code that says exactly what is wrong: Fanpage removed or off, permission
 * `read_insights` not granted, no "Analyze" task on the Page, Facebook refusing the Page, rate limit, outage.
 */
export async function loadInsights(userId: string, pageRowId: string, range: DateRange, now: Date = new Date()): Promise<InsightsResult> {
  const page = await requireInsightsPage(userId, pageRowId);

  return runWithPageToken(userId, page.id, "read", `insights of page ${page.id}`, async (token) => {
    const current = await readRange(userId, token, page.page_id, [...INSIGHT_METRICS], range);

    // The comparison asks only for metrics that worked, and never fails the page: without it the cards just show no change.
    const compareRange = previousRange(range, now);
    const working = INSIGHT_METRICS.filter((def) => "points" in (current.get(def.key) ?? {}));
    let previous: Read | null = null;
    if (compareRange && working.length) {
      try { previous = await readRange(userId, token, page.page_id, working, compareRange); }
      catch (e) { console.warn("insights: the previous period could not be read; showing no comparison:", e); }
    }

    return {
      page: { id: page.id, name: page.page_name },
      range,
      previous: previous ? compareRange : null,
      metrics: INSIGHT_METRICS.map((def) => buildResult(def, current.get(def.key), previous?.get(def.key))),
      fetchedAt: new Date().toISOString()
    };
  });
}

function buildResult(def: MetricDef, current: ReadEntry | undefined, previous: ReadEntry | undefined): MetricResult {
  const base = { key: def.key, label: def.label, hint: def.hint, unit: def.unit, aggregate: def.aggregate, goodWhen: def.goodWhen };
  const problem = (code: ErrorCode): MetricResult => ({ ...base, state: "problem", code, message: messageFor(code) });
  if (!current) return problem("INSIGHTS_NO_DATA");
  if ("problem" in current) return problem(current.problem);

  const value = mainValue(def.aggregate, current.points);
  if (value === null) return problem("INSIGHTS_NO_DATA");
  const previousPoints = previous && "points" in previous ? previous.points : null;
  const previousValue = previousPoints ? mainValue(def.aggregate, previousPoints) : null;
  const percent = changePercent(value, previousValue);
  const known = current.points.filter((p) => p.value !== null);
  return {
    ...base, state: "ok", value, previousValue, changePct: percent, tone: changeTone(percent, def.goodWhen),
    delta: def.aggregate === "last" && known.length > 1 ? (known[known.length - 1].value as number) - (known[0].value as number) : null,
    series: current.points, previousSeries: previousPoints
  };
}
