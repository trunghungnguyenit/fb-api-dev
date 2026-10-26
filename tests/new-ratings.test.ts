import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: vi.fn() }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { syncPageFeed, type FeedPage } from "@/lib/feed-sync";
import { MetaApiError } from "@/lib/meta/client";
import { describeNotification, dedupeKeys } from "@/lib/notification-text";
import { readRatingCount, recordRatingCount } from "@/lib/new-ratings";

const NOW = new Date("2026-10-21T12:00:00Z");
const MIN = 60_000;
const page: FeedPage = { id: "pr1", user_id: "u1", page_id: "fb1", page_access_token_encrypted: "enc" };
const pageRow = () => fake.tables.facebook_pages.find((p) => p.id === "pr1")!;
const notifications = () => fake.tables.notifications.filter((n) => n.type === "NEW_RATINGS");

/** Facebook: the Page's feed is empty, and it has `ratings` ratings (undefined = does not say). */
const facebook = (ratings: number | undefined) => metaGet.mockImplementation(async (path: string, _t: string, params: { fields?: string }) => {
  if (params?.fields === "rating_count") return ratings === undefined ? {} : { rating_count: ratings };
  return { data: [] };
});
const sync = (minutes: number) => syncPageFeed(page, new Date(NOW.getTime() + minutes * MIN));

beforeEach(() => {
  fake.reset();
  metaGet.mockReset();
  fake.tables.facebook_pages.push({
    ...page, page_name: "HTStudio", is_active: true, removed_at: null, feed_next_sync_at: null, feed_synced_at: null, feed_sync_error: null,
    ratings_count: null
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the notification text", () => {
  it("says how many and links to the ratings of that Fanpage", () => {
    const text = describeNotification({ type: "NEW_RATINGS", page_id: "pr1", params: { count: 3 } }, "HTStudio");
    expect(text).toMatchObject({ title: "3 đánh giá mới trên HTStudio", href: "/posts?source=ratings&page=pr1" });
    expect(describeNotification({ type: "NEW_RATINGS" })).toMatchObject({ title: "1 đánh giá mới", href: "/posts?source=ratings" });
  });
  it("starts a new round of keys for each round", () => {
    expect(dedupeKeys.newRatings("pr1", 1)).not.toBe(dedupeKeys.newRatings("pr1", 2));
  });
});

describe("readRatingCount", () => {
  it("is the number Facebook gives, and nothing for a Page that has no ratings section or when Facebook fails", async () => {
    metaGet.mockResolvedValue({ rating_count: 7 });
    expect(await readRatingCount("t", "fb1")).toBe(7);
    expect(metaGet).toHaveBeenCalledWith("fb1", "t", { fields: "rating_count" });
    metaGet.mockResolvedValue({});
    expect(await readRatingCount("t", "fb1")).toBeNull();
    metaGet.mockRejectedValue(new MetaApiError("(#100) nonexisting field", "100", 400));
    expect(await readRatingCount("t", "fb1")).toBeNull();
    metaGet.mockRejectedValue(new Error("network down"));
    expect(await readRatingCount("t", "fb1")).toBeNull();
  });
});

describe("announcing new ratings from the sync", () => {
  it("stays quiet the first time, however many ratings the Page already has, and takes that as the starting point", async () => {
    facebook(40);
    await sync(0);
    expect(notifications()).toHaveLength(0);
    expect(pageRow()).toMatchObject({ ratings_count: 40 });
  });

  it("announces the ratings that arrived since the previous read, once", async () => {
    facebook(40); await sync(0);
    facebook(43); await sync(5);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]).toMatchObject({ page_id: "pr1", params: { count: 3 } });
    expect(notifications()[0].read_at ?? null).toBeNull();
    expect(pageRow()).toMatchObject({ ratings_count: 43 });
    facebook(43); await sync(10);
    expect(notifications()).toHaveLength(1);
  });

  it("adds up while the notification is unread and starts a new one once it was read", async () => {
    facebook(10); await sync(0);
    facebook(11); await sync(5);
    facebook(13); await sync(10);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 3 });
    notifications()[0].read_at = NOW.toISOString();
    facebook(14); await sync(15);
    expect(notifications()).toHaveLength(2);
    expect(notifications()[1].params).toMatchObject({ count: 1 });
  });

  it("does not announce a lower count (a rating was removed) and lowers the stored count", async () => {
    facebook(10); await sync(0);
    facebook(8); await sync(5);
    expect(notifications()).toHaveLength(0);
    expect(pageRow()).toMatchObject({ ratings_count: 8 });
  });

  it("changes nothing when Facebook does not say, and never fails the feed read", async () => {
    facebook(10); await sync(0);
    facebook(undefined);
    expect(await sync(5)).toMatchObject({ status: "synced" });
    metaGet.mockImplementation(async (_p: string, _t: string, params: { fields?: string }) => {
      if (params?.fields === "rating_count") throw new MetaApiError("(#100) nonexisting field", "100", 400);
      return { data: [] };
    });
    expect(await sync(10)).toMatchObject({ status: "synced" });
    expect(pageRow()).toMatchObject({ ratings_count: 10 });
    expect(notifications()).toHaveLength(0);
  });

  it("two reads running at once count the same new ratings only once", async () => {
    facebook(10); await sync(0);
    await Promise.all([recordRatingCount("u1", "pr1", 12, NOW), recordRatingCount("u1", "pr1", 12, new Date(NOW.getTime() + 1))]);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].params).toMatchObject({ count: 2 });
    expect(pageRow()).toMatchObject({ ratings_count: 12 });
  });

  it("is not asked again for the second read of one manual sync", async () => {
    facebook(10);
    await syncPageFeed(page, NOW, { ratings: false });
    expect(metaGet.mock.calls.filter((c) => (c[2] as { fields?: string }).fields === "rating_count")).toHaveLength(0);
    expect(pageRow().ratings_count).toBeNull();
  });

  it("a failure while recording does not fail the read either", async () => {
    facebook(10); await sync(0);
    vi.spyOn(fake, "from").mockImplementationOnce(() => { throw new Error("database down"); });
    await expect(recordRatingCount("u1", "pr1", 99, NOW)).resolves.toBeUndefined();
  });
});
