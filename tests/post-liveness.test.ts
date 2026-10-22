import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const metaGet = vi.fn();
const deactivatePage = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));
vi.mock("@/lib/meta/client", async (original) => ({
  ...(await original<typeof import("@/lib/meta/client")>()), metaGet: (...a: unknown[]) => metaGet(...a)
}));

import { verifyOlderPosts } from "@/lib/post-liveness";
import { MetaApiError } from "@/lib/meta/client";

const NOW = new Date("2026-10-22T12:00:00Z");
const DAY = 24 * 3600_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const goneError = () => new MetaApiError("(#10) Object does not exist, cannot be loaded due to missing permission or review", "10", 400);

const addPost = (id: string, over: Record<string, unknown> = {}) => fake.tables.posts.push({
  id, user_id: "u1", page_id: "pr1", post_type: "text", status: "published", facebook_post_id: `fb_${id}`, published_at: daysAgo(10),
  facebook_deleted_at: null, facebook_checked_at: null, ...over
});
const post = (id: string) => fake.tables.posts.find((p) => p.id === id)!;

beforeEach(() => {
  fake.reset();
  metaGet.mockReset();
  deactivatePage.mockReset();
  fake.tables.facebook_pages.push({ id: "pr1", user_id: "u1", page_id: "fb1", page_access_token_encrypted: "enc", is_active: true, removed_at: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("verifyOlderPosts", () => {
  it("marks an old post deleted when Facebook says it does not exist and the Page token still works, and tells the user", async () => {
    addPost("p1");
    metaGet.mockImplementation(async (path: string) => { if (path === "fb_p1") throw goneError(); return { id: "fb1" }; });
    expect(await verifyOlderPosts({ now: NOW })).toMatchObject({ checked: 1, gone: 1, failed: 0 });
    expect(post("p1").facebook_deleted_at).not.toBeNull();
    expect(post("p1").facebook_checked_at).toBe(NOW.toISOString());
    expect(fake.tables.notifications[0]).toMatchObject({ type: "POST_DELETED_ON_FACEBOOK", post_id: "p1", page_id: "pr1" });
  });

  it("leaves a post that is still there, and does not ask again for a day", async () => {
    addPost("p1");
    metaGet.mockResolvedValue({ message: "x", reactions: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } }, shares: { count: 0 } });
    expect(await verifyOlderPosts({ now: NOW })).toMatchObject({ checked: 1, gone: 0 });
    expect(post("p1").facebook_deleted_at).toBeNull();
    metaGet.mockClear();
    expect(await verifyOlderPosts({ now: new Date(NOW.getTime() + 3600_000) })).toMatchObject({ checked: 0 });
    expect(metaGet).not.toHaveBeenCalled();
    expect(await verifyOlderPosts({ now: new Date(NOW.getTime() + 25 * 3600_000) })).toMatchObject({ checked: 1 });
  });

  it("does not believe 'does not exist' when the Page token itself no longer works", async () => {
    addPost("p1");
    metaGet.mockImplementation(async (path: string) => { throw path === "fb_p1" ? goneError() : new MetaApiError("(#10) permission", "10", 403); });
    expect(await verifyOlderPosts({ now: NOW })).toMatchObject({ checked: 1, gone: 0 });
    expect(post("p1").facebook_deleted_at).toBeNull();
  });

  it("only looks at published posts older than the 7-day window that are not marked yet", async () => {
    addPost("recent", { published_at: daysAgo(2) });
    addPost("draft", { status: "draft", facebook_post_id: null });
    addPost("marked", { facebook_deleted_at: daysAgo(1) });
    metaGet.mockResolvedValue({});
    expect(await verifyOlderPosts({ now: NOW })).toMatchObject({ checked: 0 });
    expect(metaGet).not.toHaveBeenCalled();
  });

  it("checks the longest-unchecked first and no more than the limit", async () => {
    addPost("a", { facebook_checked_at: daysAgo(3) });
    addPost("b", { facebook_checked_at: null });
    addPost("c", { facebook_checked_at: daysAgo(5) });
    metaGet.mockResolvedValue({});
    await verifyOlderPosts({ now: NOW, limit: 2 });
    expect(post("b").facebook_checked_at).toBe(NOW.toISOString());
    expect(post("c").facebook_checked_at).toBe(NOW.toISOString());
    expect(post("a").facebook_checked_at).toBe(daysAgo(3));
  });

  it("stops without stamping when Facebook rate-limits, so those posts stay first in line", async () => {
    addPost("p1");
    metaGet.mockRejectedValue(new MetaApiError("too many calls", "32", 400));
    expect(await verifyOlderPosts({ now: NOW })).toMatchObject({ stoppedEarly: true, gone: 0 });
    expect(post("p1").facebook_checked_at).toBeNull();
  });
});
