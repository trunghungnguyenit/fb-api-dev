import { type ErrorCode, messageFor } from "@/lib/errors";
import { runWithPageToken } from "@/lib/facebook-posts";
import { knownUnsupported, refusalOf, requireInsightsPage } from "@/lib/insights";
import { metaGet } from "@/lib/meta/client";
import { buildRows, DEMOGRAPHICS, type DemographicBlock, type DemographicDef, type DemographicKey, parseBreakdown } from "@/lib/meta/demographics";

// Who follows a Fanpage, read from Facebook when the Insights page is opened. Nothing is stored; what was read is kept in memory
// for a short while. Every breakdown is asked for on its own account (Meta keeps retiring metrics): one that Facebook refuses is
// reported for that block, the others still show.

export type DemographicResult = {
  key: DemographicKey; label: string; hint: string;
  state: "ok" | "problem";
  /** state "problem": which of our codes, and its Vietnamese text (Facebook's own wording is never passed on). */
  code?: ErrorCode; message?: string;
  /** state "ok" */
  block?: DemographicBlock;
};

export type DemographicsResult = { page: { id: string; name: string }; blocks: DemographicResult[]; fetchedAt: string };

// ---- Short memory ------------------------------------------------------------------------------------------------------
// These change about once a day. What Facebook REFUSED, or had nothing for, is remembered only briefly so that "Thử lại" can find out.
const VALUE_MS = 30 * 60_000;
const PROBLEM_MS = 5 * 60_000;
const CACHE_MAX = 400;
type Entry = { block: DemographicBlock } | { problem: ErrorCode };
const cache = new Map<string, { at: number; entry: Entry }>();
export function clearDemographicsCache() { cache.clear(); }
const keyOf = (userId: string, pageFbId: string, graph: string) => `${userId}|${pageFbId}|${graph}`;
const fresh = (hit: { at: number; entry: Entry }) => Date.now() - hit.at < ("problem" in hit.entry ? PROBLEM_MS : VALUE_MS);
function remember(key: string, entry: Entry) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), entry });
}

async function readOne(userId: string, token: string, pageFbId: string, def: DemographicDef): Promise<Entry> {
  if (knownUnsupported(def.graph)) return { problem: "INSIGHTS_METRIC_UNSUPPORTED" };
  const key = keyOf(userId, pageFbId, def.graph);
  const hit = cache.get(key);
  if (hit && fresh(hit)) return hit.entry;
  let entry: Entry;
  try {
    const raw = parseBreakdown(await metaGet(`${pageFbId}/insights`, token, { metric: def.graph, period: "day" }), def.graph);
    const block = raw ? buildRows(raw, def.key) : null;
    entry = block ? { block } : { problem: "DEMOGRAPHICS_NO_DATA" };
  } catch (e) {
    // Throws for what stops the whole read (dead token, rate limit, refused Page). Not remembered for everybody: a Page with few
    // followers may be refused what a larger one is given.
    entry = { problem: refusalOf(e, def.graph, { remember: false }) };
  }
  remember(key, entry);
  return entry;
}

/**
 * Followers of one of the user's Fanpages by country, city and (if Facebook still gives it) gender and age. Throws
 * FacebookActionError with a code that says exactly what is wrong: Fanpage removed or off, `read_insights` not granted, no
 * "Analyze" task, Facebook refusing the Page, rate limit, outage.
 */
export async function loadDemographics(userId: string, pageRowId: string): Promise<DemographicsResult> {
  const page = await requireInsightsPage(userId, pageRowId);
  return runWithPageToken(userId, page.id, "read", `demographics of page ${page.id}`, async (token) => {
    const blocks: DemographicResult[] = [];
    for (const def of DEMOGRAPHICS) {
      const base = { key: def.key, label: def.label, hint: def.hint };
      const entry = await readOne(userId, token, page.page_id, def);
      blocks.push("problem" in entry
        ? { ...base, state: "problem", code: entry.problem, message: messageFor(entry.problem) }
        : { ...base, state: "ok", block: entry.block });
    }
    return { page: { id: page.id, name: page.page_name }, blocks, fetchedAt: new Date().toISOString() };
  });
}
