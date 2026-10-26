// Who follows a Fanpage: where from and (if Facebook still says) how old and what gender. Pure module (safe for client and
// server). Facebook answers these Page metrics with numbers BY NAME (a country code, a city, "F.25-34"); like every Insights
// metric they come and go, so each one is read on its own and a refusal is reported for that block alone (lib/demographics.ts).

export type DemographicKey = "countries" | "cities" | "genderAge";

export type DemographicDef = {
  key: DemographicKey;
  /** The metric's name in the Graph API. */
  graph: string;
  label: string;
  hint: string;
};

export const DEMOGRAPHICS: readonly DemographicDef[] = [
  { key: "countries", graph: "page_follows_country", label: "Quốc gia", hint: "Nơi người theo dõi Fanpage sống, theo quốc gia." },
  { key: "cities", graph: "page_follows_city", label: "Thành phố", hint: "Nơi người theo dõi Fanpage sống, theo thành phố." },
  { key: "genderAge", graph: "page_follows_gender_age", label: "Giới tính và độ tuổi", hint: "Người theo dõi chia theo giới tính và nhóm tuổi (Facebook có thể không còn cung cấp)." }
];

/** How many rows a block shows; the rest are added up as "Khác". */
export const DEMOGRAPHIC_ROWS = 10;

/** Numbers by name, from the latest `values` entry. An empty object is "Facebook has nothing" (too few followers), not zero. */
export function parseBreakdown(body: unknown, graph: string): Record<string, number> | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if ((entry as { name?: unknown })?.name !== graph) continue;
    const values = (entry as { values?: unknown })?.values;
    if (!Array.isArray(values)) return null;
    // Newest last; take the newest one that has numbers in it.
    for (let i = values.length - 1; i >= 0; i--) {
      const value = (values[i] as { value?: unknown } | undefined)?.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const out: Record<string, number> = {};
      for (const [key, n] of Object.entries(value)) if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
      if (Object.keys(out).length) return out;
    }
    return null;
  }
  return null;
}

let regionNames: Intl.DisplayNames | null | undefined;
/** "VN" -> "Việt Nam"; an unknown code stays as it is. */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(["vi"], { type: "region" }); } catch { regionNames = null; }
  }
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

const GENDERS: Record<string, string> = { F: "Nữ", M: "Nam", U: "Không rõ giới tính" };

/** "F.25-34" -> "Nữ, 25–34 tuổi"; "M.65+" -> "Nam, 65+ tuổi". Anything else stays as it is. */
export function genderAgeLabel(key: string): string {
  const match = /^([A-Z])\.(\d{2}(?:-\d{2}|\+))$/.exec(key);
  if (!match) return key;
  return `${GENDERS[match[1]] ?? match[1]}, ${match[2].replace("-", "–")} tuổi`;
}

export type DemographicRow = { key: string; label: string; value: number; share: number };
export type DemographicBlock = { total: number; rows: DemographicRow[]; others: number };

/** The biggest groups first (at most `limit`), each with its share of all followers counted in the block. */
export function buildRows(raw: Record<string, number>, key: DemographicKey, limit = DEMOGRAPHIC_ROWS): DemographicBlock | null {
  const label = (name: string) => (key === "countries" ? countryName(name) : key === "genderAge" ? genderAgeLabel(name) : name);
  const entries = Object.entries(raw).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!entries.length || total <= 0) return null;
  const shown = entries.slice(0, limit);
  return {
    total,
    rows: shown.map(([name, value]) => ({ key: name, label: label(name), value, share: value / total })),
    others: entries.slice(limit).reduce((sum, [, value]) => sum + value, 0)
  };
}
