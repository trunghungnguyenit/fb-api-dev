import { describe, expect, it, vi } from "vitest";
import { runPublishPool, type PoolOutcome, type PoolPost } from "@/lib/publish-pool";

type Post = PoolPost & { lane?: string };

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Short "latencies" are a few event-loop turns: they overlap like real calls do but do not pay Windows' ~15 ms timer granularity.
const sleep = async (ms: number) => {
  if (ms >= 5) return realSleep(ms);
  for (let i = 0; i < Math.max(1, Math.round(ms)); i++) await new Promise((r) => setImmediate(r));
};

/** A queue of due posts served in windows, like the database does (oldest first, `cursor` = how many were served). */
function source(posts: Post[], window = 200) {
  const fetches: number[] = [];
  return {
    fetches,
    fetchBatch: async (cursor: number | null) => {
      const from = cursor ?? 0;
      fetches.push(from);
      return { posts: posts.slice(from, from + window), cursor: from + window };
    }
  };
}

/** Publish stand-in that records overlap: how many ran at once overall, per Page, and per lane. */
function tracker(latencyMs: (post: Post) => number = () => 1, outcome: (post: Post) => PoolOutcome = () => ({ result: "published" })) {
  const done: string[] = [];
  const startOrder: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const perPage = new Map<string, number>();
  const maxPerPage = new Map<string, number>();
  const perLane = new Map<string, number>();
  const maxPerLane = new Map<string, number>();
  const publish = async (post: Post) => {
    startOrder.push(post.id);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const lane = post.lane ?? "default";
    for (const [map, max, key] of [[perPage, maxPerPage, post.page_id], [perLane, maxPerLane, lane]] as const) {
      map.set(key, (map.get(key) ?? 0) + 1);
      max.set(key, Math.max(max.get(key) ?? 0, map.get(key)!));
    }
    await sleep(latencyMs(post));
    inFlight--;
    perPage.set(post.page_id, perPage.get(post.page_id)! - 1);
    perLane.set(lane, perLane.get(lane)! - 1);
    done.push(post.id);
    return outcome(post);
  };
  return { publish, done, startOrder, maxInFlight: () => maxInFlight, maxPerPage, maxPerLane };
}

const post = (id: string, user: string, page: string, lane?: string): Post => ({ id, user_id: user, page_id: page, lane });

describe("runPublishPool", () => {
  it("publishes a burst of 2000 posts from 100 users exactly once each, in parallel, never two at once per Page", async () => {
    const posts: Post[] = [];
    for (let i = 0; i < 2000; i++) {
      const user = `u${i % 100}`;
      posts.push(post(`p${i}`, user, `${user}-page${i % 7}`));
    }
    const src = source(posts);
    const t = tracker(() => 1 + Math.random() * 2); // 1-3 ms stands in for 1-3 s

    const stats = await runPublishPool({ ...src, publish: t.publish, concurrency: { default: 8 }, budgetMs: 60_000 });

    expect(stats).toMatchObject({ started: 2000, published: 2000, failed: 0, stopReason: "drained", hasMore: false });
    expect(new Set(t.done).size).toBe(2000);
    expect(t.maxInFlight()).toBe(8);
    expect(stats.maxInFlight).toBe(8);
    expect(Math.max(...t.maxPerPage.values())).toBe(1);
    expect(stats.avgPublishMs).toBeGreaterThanOrEqual(0);
  });

  it("never runs two posts of the same Page together, while other Pages run alongside it", async () => {
    const posts = [
      ...Array.from({ length: 20 }, (_, i) => post(`a${i}`, "A", "pageA")),
      ...Array.from({ length: 6 }, (_, i) => post(`b${i}`, "B", `pageB${i}`))
    ];
    const t = tracker(() => 3);
    await runPublishPool({ ...source(posts), publish: t.publish, concurrency: { default: 8 }, budgetMs: 60_000 });
    expect(t.maxPerPage.get("pageA")).toBe(1);
    expect(t.maxInFlight()).toBeGreaterThan(1);
    expect(t.done).toHaveLength(26);
  });

  it("keeps the other slots busy when the first window is all one Page's backlog", async () => {
    // 300 posts of one Page come first (older), then 40 posts of 40 other Pages beyond the first window of 200.
    const posts = [
      ...Array.from({ length: 300 }, (_, i) => post(`big${i}`, "A", "bigPage")),
      ...Array.from({ length: 40 }, (_, i) => post(`s${i}`, `u${i}`, `small${i}`))
    ];
    const t = tracker(() => 2);
    const small = new Set<string>();
    const stats = await runPublishPool({
      ...source(posts, 200),
      publish: async (p) => { const out = await t.publish(p); if (p.id.startsWith("s")) small.add(p.id); return out; },
      concurrency: { default: 8 }, budgetMs: 60_000, limit: 100
    });
    // With one slot stuck behind the big Page, the small Pages still get through well within the first 100 posts.
    expect(small.size).toBe(40);
    expect(stats.maxInFlight).toBeGreaterThan(4);
  });

  it("lets users take turns instead of serving one big backlog first", async () => {
    const posts = [
      ...Array.from({ length: 50 }, (_, i) => post(`a${i}`, "A", `pa${i}`)),
      ...Array.from({ length: 3 }, (_, i) => post(`b${i}`, "B", `pb${i}`)),
      ...Array.from({ length: 3 }, (_, i) => post(`c${i}`, "C", `pc${i}`))
    ];
    const t = tracker(() => 1);
    await runPublishPool({ ...source(posts), publish: t.publish, concurrency: { default: 1 }, budgetMs: 60_000 });
    const firstNine = t.startOrder.slice(0, 9).map((id) => id[0]);
    expect(firstNine.filter((u) => u === "b")).toHaveLength(3);
    expect(firstNine.filter((u) => u === "c")).toHaveLength(3);
  });

  it("caps each lane separately, so slow work cannot take every slot", async () => {
    const posts = [
      ...Array.from({ length: 12 }, (_, i) => post(`h${i}`, `uh${i}`, `ph${i}`, "heavy")),
      ...Array.from({ length: 40 }, (_, i) => post(`f${i}`, `uf${i}`, `pf${i}`, "fast"))
    ];
    const t = tracker((p) => (p.lane === "heavy" ? 8 : 1));
    const stats = await runPublishPool({
      ...source(posts), publish: t.publish, concurrency: { fast: 6, heavy: 2 }, laneOf: (p) => p.lane ?? "fast", budgetMs: 60_000
    });
    expect(t.maxPerLane.get("heavy")).toBe(2);
    expect(t.maxPerLane.get("fast")).toBeLessThanOrEqual(6);
    expect(stats.published).toBe(52);
  });

  it("leaves a blocked Page alone for the rest of the run, without touching its other posts", async () => {
    const posts = [
      ...Array.from({ length: 10 }, (_, i) => post(`dead${i}`, "A", "deadPage")),
      ...Array.from({ length: 5 }, (_, i) => post(`ok${i}`, "B", `okPage${i}`))
    ];
    const t = tracker(() => 1, (p) => (p.page_id === "deadPage" ? { result: "requeued", blockPageUntil: Infinity } : { result: "published" }));
    const stats = await runPublishPool({ ...source(posts), publish: t.publish, concurrency: { default: 4 }, budgetMs: 60_000 });
    expect(t.done.filter((id) => id.startsWith("dead"))).toHaveLength(1);
    expect(stats).toMatchObject({ published: 5, requeued: 1, skippedBlocked: 9, stopReason: "drained" });
  });

  it("a timed block ends: the Page is used again afterwards", async () => {
    let t = 1000;
    const posts = [post("x1", "A", "p"), post("x2", "A", "p"), post("y1", "B", "q")];
    const calls: string[] = [];
    const stats = await runPublishPool({
      ...source(posts),
      publish: async (p) => {
        calls.push(p.id);
        if (p.id === "x1") return { result: "requeued", blockPageUntil: t + 50 };
        if (p.id === "y1") t += 100; // time passes while another Page publishes
        return { result: "published" };
      },
      concurrency: { default: 1 }, budgetMs: 60_000, now: () => t
    });
    // x1 blocks Page p for 50 "ms"; y1 takes 100, so by the time x2's turn comes the block is over.
    expect(calls).toEqual(["x1", "y1", "x2"]);
    expect(stats.skippedBlocked).toBe(0);
  });

  it("stops starting posts when the time budget ends, lets running ones finish, and says more is due", async () => {
    const posts = Array.from({ length: 100 }, (_, i) => post(`p${i}`, `u${i}`, `page${i}`));
    const t = tracker(() => 10);
    const stats = await runPublishPool({ ...source(posts), publish: t.publish, concurrency: { default: 2 }, budgetMs: 35 });
    expect(stats.stopReason).toBe("budget");
    expect(stats.hasMore).toBe(true);
    expect(stats.started).toBeLessThan(100);
    expect(t.done).toHaveLength(stats.started); // everything started was awaited
  });

  it("reports drained, not budget, when the budget ends with nothing left", async () => {
    let t = 0; // a fake clock, so this does not depend on how fast the machine is
    const stats = await runPublishPool({
      ...source([post("p", "u", "page")]),
      publish: async () => { t += 100; return { result: "published" }; }, // the only post takes longer than the whole budget
      concurrency: { default: 1 }, budgetMs: 1, now: () => t
    });
    expect(stats).toMatchObject({ started: 1, stopReason: "drained", hasMore: false });
  });

  it("honours the limit", async () => {
    const posts = Array.from({ length: 30 }, (_, i) => post(`p${i}`, `u${i}`, `page${i}`));
    const stats = await runPublishPool({ ...source(posts), publish: tracker().publish, concurrency: { default: 4 }, budgetMs: 60_000, limit: 10 });
    expect(stats).toMatchObject({ started: 10, stopReason: "limit", hasMore: true });
  });

  it("stops when asked to pause (for instance when the whole app is rate limited)", async () => {
    const posts = Array.from({ length: 50 }, (_, i) => post(`p${i}`, `u${i}`, `page${i}`));
    const t = tracker(() => 2);
    const stats = await runPublishPool({
      ...source(posts), publish: t.publish, concurrency: { default: 2 }, budgetMs: 60_000, shouldPause: () => t.done.length >= 6
    });
    expect(stats.stopReason).toBe("paused");
    expect(stats.started).toBeLessThan(50);
    expect(t.done).toHaveLength(stats.started);
  });

  it("counts every kind of outcome", async () => {
    const posts = ["published", "failed", "requeued", "lost"].map((r, i) => post(`p${i}`, `u${i}`, `page${i}`));
    const stats = await runPublishPool({
      ...source(posts), publish: async (p) => ({ result: posts.indexOf(p) === 0 ? "published" : posts.indexOf(p) === 1 ? "failed" : posts.indexOf(p) === 2 ? "requeued" : "lost" }),
      concurrency: { default: 2 }, budgetMs: 60_000
    });
    expect(stats).toMatchObject({ started: 4, published: 1, failed: 1, requeued: 1, lost: 1 });
  });

  it("survives a publish that throws, and then leaves that Page alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = [post("a1", "A", "bad"), post("a2", "A", "bad"), post("b1", "B", "good")];
    const stats = await runPublishPool({
      ...source(posts),
      publish: async (p) => { if (p.page_id === "bad") throw new Error("boom"); return { result: "published" }; },
      concurrency: { default: 1 }, budgetMs: 60_000
    });
    expect(stats).toMatchObject({ failed: 1, published: 1, skippedBlocked: 1, stopReason: "drained" });
  });

  it("never handles a post twice in one run, and stops fetching when a batch brings nothing new", async () => {
    const posts = [post("p1", "A", "pa"), post("p2", "B", "pb")];
    let fetches = 0;
    const t = tracker(() => 1);
    const stats = await runPublishPool({
      // A paging bug: every fetch returns the same rows again.
      fetchBatch: async () => { fetches++; return { posts, cursor: null }; },
      publish: t.publish, concurrency: { default: 2 }, budgetMs: 60_000
    });
    expect(t.done.sort()).toEqual(["p1", "p2"]);
    expect(fetches).toBe(2);
    expect(stats).toMatchObject({ started: 2, stopReason: "drained" });
  });

  it("fetches window by window", async () => {
    const posts = Array.from({ length: 450 }, (_, i) => post(`p${i}`, `u${i}`, `page${i}`));
    const src = source(posts, 200);
    const stats = await runPublishPool({ ...src, publish: tracker(() => 0).publish, concurrency: { default: 8 }, budgetMs: 60_000 });
    expect(stats.published).toBe(450);
    expect(src.fetches.slice(0, 3)).toEqual([0, 200, 400]);
  });

  it("fails if the very first fetch fails, but finishes gracefully if a later one does", async () => {
    await expect(runPublishPool({
      fetchBatch: async () => { throw new Error("db down"); }, publish: tracker().publish, concurrency: { default: 2 }, budgetMs: 1000
    })).rejects.toThrow("db down");

    vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = Array.from({ length: 10 }, (_, i) => post(`p${i}`, `u${i}`, `page${i}`));
    let calls = 0;
    const stats = await runPublishPool({
      fetchBatch: async (cursor: number | null) => {
        if (calls++ > 0) throw new Error("db down later");
        return { posts: posts.slice(cursor ?? 0, 10), cursor: 10 };
      },
      publish: tracker().publish, concurrency: { default: 2 }, budgetMs: 1000
    });
    expect(stats).toMatchObject({ published: 10, stopReason: "error", hasMore: false });
  });

  it("handles an empty queue", async () => {
    const stats = await runPublishPool({ ...source([]), publish: tracker().publish, concurrency: { default: 4 }, budgetMs: 1000 });
    expect(stats).toMatchObject({ started: 0, stopReason: "drained", hasMore: false, fetches: 1 });
  });
});
