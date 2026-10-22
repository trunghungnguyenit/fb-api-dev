import { describe, expect, it } from "vitest";
import { FEED_STALE_AFTER_MS, feedIsStale } from "@/lib/feed-freshness";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const page = (over: Partial<{ is_active: boolean; removed_at: string | null; feed_synced_at: string | null }> = {}) =>
  ({ is_active: true, removed_at: null, feed_synced_at: ago(0), ...over });

describe("feedIsStale", () => {
  it("is fresh when every active Fanpage was read within the last minute", () => {
    expect(feedIsStale([page(), page({ feed_synced_at: ago(FEED_STALE_AFTER_MS - 1) })], NOW)).toBe(false);
  });
  it("is stale when one active Fanpage was never read or was read longer ago", () => {
    expect(feedIsStale([page({ feed_synced_at: null })], NOW)).toBe(true);
    expect(feedIsStale([page(), page({ feed_synced_at: ago(FEED_STALE_AFTER_MS + 1) })], NOW)).toBe(true);
  });
  it("ignores Fanpages that are off or removed, and having none", () => {
    expect(feedIsStale([page({ is_active: false, feed_synced_at: null }), page({ removed_at: ago(1), feed_synced_at: null })], NOW)).toBe(false);
    expect(feedIsStale([], NOW)).toBe(false);
  });
});
