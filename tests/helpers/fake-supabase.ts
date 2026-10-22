// A small in-memory stand-in for the parts of supabase-js the app uses, so real application code (userDb, the media
// service, the cleanup job, the publisher) can run against it in tests. It understands the filters and verbs
// those modules use, and nothing more: an unknown method throws instead of silently returning everything.
export type Row = Record<string, unknown>;

const isNull = (v: unknown) => v === null || v === undefined;

function compare(a: unknown, b: unknown) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Evaluates one `column.op.value` condition as written in a PostgREST `or(...)` string. */
function condition(spec: string): (row: Row) => boolean {
  const [column, op, ...rest] = spec.split(".");
  const value = rest.join(".");
  switch (op) {
    case "is": return (r) => (value === "null" ? isNull(r[column]) : String(r[column]) === value);
    case "eq": return (r) => String(r[column]) === value;
    case "neq": return (r) => String(r[column]) !== value;
    case "lt": return (r) => !isNull(r[column]) && compare(r[column], value) < 0;
    case "lte": return (r) => !isNull(r[column]) && compare(r[column], value) <= 0;
    case "gte": return (r) => !isNull(r[column]) && compare(r[column], value) >= 0;
    case "gt": return (r) => !isNull(r[column]) && compare(r[column], value) > 0;
    default: throw new Error(`fake supabase: unsupported condition "${spec}"`);
  }
}

/** Splits on commas that are not inside parentheses (PostgREST "or" syntax: a.eq.1,and(b.gt.2,c.lt.3)). */
function splitTop(spec: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of spec) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function parseOr(spec: string): (row: Row) => boolean {
  const options = splitTop(spec).map((term) => {
    const and = /^and((.*))$/.exec(term);
    if (!and) return condition(term);
    const all = splitTop(and[1]).map(condition);
    return (r: Row) => all.every((f) => f(r));
  });
  return (r) => options.some((f) => f(r));
}

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private inserts: Row[] | null = null;
  private deleting = false;
  private wantsRows = false;
  private countMode = false;
  private headOnly = false;
  private orderBy: { column: string; ascending: boolean; nullsFirst?: boolean }[] = [];
  private max = Infinity;

  constructor(private db: FakeSupabase, private table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.wantsRows = true;
    if (options?.count) this.countMode = true;
    if (options?.head) this.headOnly = true;
    return this;
  }
  update(patch: Row) { this.patch = patch; return this; }
  delete() { this.deleting = true; return this; }
  insert(row: Row | Row[]) {
    const list = Array.isArray(row) ? row : [row];
    this.inserts = list.map((r) => ({ id: `row${this.db.nextId++}`, ...r }));
    const existing = this.db.tables[this.table];
    for (const r of this.inserts) {
      // unique (user_id, dedupe_key), as the notifications table has
      if (this.table === "notifications" && existing.some((e) => e.user_id === r.user_id && e.dedupe_key === r.dedupe_key)) {
        this.db.insertError = { code: "23505" };
        this.inserts = [];
        return this;
      }
      existing.push(r);
    }
    return this;
  }

  /** Insert, or update the row with the same `onConflict` columns (merging only the given columns, like PostgREST). */
  upsert(row: Row | Row[], options?: { onConflict?: string }) {
    const list = Array.isArray(row) ? row : [row];
    const columns = (options?.onConflict ?? "id").split(",").map((c) => c.trim());
    const table = this.db.tables[this.table];
    this.inserts = list.map((r) => {
      const existing = table.find((e) => columns.every((c) => e[c] === r[c]));
      if (existing) { Object.assign(existing, r); return existing; }
      const created = { id: `row${this.db.nextId++}`, ...r };
      table.push(created);
      return created;
    });
    return this;
  }

  eq(column: string, value: unknown) { this.filters.push((r) => r[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((r) => r[column] !== value); return this; }
  is(column: string, value: unknown) { this.filters.push((r) => (value === null ? isNull(r[column]) : r[column] === value)); return this; }
  not(column: string, op: string, value: unknown) {
    if (op === "is") this.filters.push((r) => !(value === null ? isNull(r[column]) : r[column] === value));
    else if (op === "in") {
      const set = String(value).replace(/^\(|\)$/g, "").split(",");
      this.filters.push((r) => !set.includes(String(r[column])));
    } else throw new Error(`fake supabase: unsupported not(${op})`);
    return this;
  }
  in(column: string, values: unknown[]) { this.filters.push((r) => values.includes(r[column])); return this; }
  lt(column: string, value: unknown) { this.filters.push((r) => !isNull(r[column]) && compare(r[column], value) < 0); return this; }
  lte(column: string, value: unknown) { this.filters.push((r) => !isNull(r[column]) && compare(r[column], value) <= 0); return this; }
  gte(column: string, value: unknown) { this.filters.push((r) => !isNull(r[column]) && compare(r[column], value) >= 0); return this; }
  or(spec: string) {
    const test = parseOr(spec);
    this.filters.push(test);
    return this;
  }
  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) { this.orderBy.push({ column, ascending: opts?.ascending !== false, nullsFirst: opts?.nullsFirst }); return this; }
  limit(n: number) { this.max = n; return this; }

  private run(): { data: unknown; error: unknown; count: number | null } {
    const none = { error: null, count: null };
    if (this.inserts) {
      const error = this.db.insertError;
      this.db.insertError = null;
      return { data: this.wantsRows ? this.inserts : null, ...none, error };
    }
    let matched = this.db.tables[this.table].filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy.length) {
      matched = [...matched].sort((a, b) => {
        for (const { column, ascending, nullsFirst } of this.orderBy) {
          // Like Postgres: nulls sort as the largest value unless nullsFirst says otherwise.
          if (nullsFirst !== undefined && isNull(a[column]) !== isNull(b[column])) return isNull(a[column]) === nullsFirst ? -1 : 1;
          const c = compare(a[column], b[column]);
          if (c) return ascending ? c : -c;
        }
        return 0;
      });
    }
    matched = matched.slice(0, this.max);
    if (this.deleting) {
      this.db.tables[this.table] = this.db.tables[this.table].filter((r) => !matched.includes(r));
      return { data: this.wantsRows ? matched : null, ...none };
    }
    if (this.patch) for (const r of matched) Object.assign(r, this.patch);
    const count = this.countMode ? matched.length : null;
    return { data: this.headOnly ? null : this.wantsRows || !this.patch ? matched : null, error: null, count };
  }

  maybeSingle() { const r = this.run(); return Promise.resolve({ ...r, data: (r.data as Row[] | null)?.[0] ?? null }); }
  single() {
    const r = this.run();
    const data = Array.isArray(r.data) ? r.data[0] : r.data;
    return Promise.resolve({ ...r, data: data ?? null });
  }
  then<T>(resolve: (v: { data: unknown; error: unknown; count?: number | null }) => T) { return Promise.resolve(this.run()).then(resolve); }
}

export class FakeSupabase {
  tables: Record<string, Row[]> = new Proxy({} as Record<string, Row[]>, {
    get: (target, prop: string) => (target[prop] ??= [])
  });
  nextId = 1;
  insertError: unknown = null;
  from = (table: string) => new Query(this, table);
  reset() { for (const key of Object.keys(this.tables)) delete this.tables[key]; this.nextId = 1; this.insertError = null; }
}
