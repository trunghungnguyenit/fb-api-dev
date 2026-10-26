import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const removeObjects = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/media/storage", () => ({ removeObjects: (...a: unknown[]) => removeObjects(...a) }));

import { cleanupMedia, PUBLISHED_TTL_MS, releasesFiles, UNATTACHED_TTL_MS } from "@/lib/media/cleanup";

const NOW = new Date("2026-10-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let n = 0;
function media(over: Record<string, unknown> = {}) {
  const row = {
    id: `m${++n}`, user_id: "u1", post_id: null, kind: "image", storage_path: `u1/m${n}/x.jpg`, state: "uploaded",
    created_at: ago(30 * DAY), ...over
  };
  fake.tables.post_media.push(row);
  return row;
}
function post(status: string, over: Record<string, unknown> = {}) {
  const row = { id: `p${++n}`, user_id: "u1", status, published_at: null, updated_at: ago(30 * DAY), ...over };
  fake.tables.posts.push(row);
  return row;
}
const paths = () => removeObjects.mock.calls.flatMap((c) => c[0] as string[]);
const state = (id: unknown) => fake.tables.post_media.find((m) => m.id === id)?.state;
const exists = (id: unknown) => fake.tables.post_media.some((m) => m.id === id);

beforeEach(() => {
  fake.reset();
  removeObjects.mockReset();
  removeObjects.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("uploads that belong to no post", () => {
  it("are removed after 24 hours, file and row", async () => {
    const old = media({ created_at: ago(UNATTACHED_TTL_MS + HOUR) });
    const fresh = media({ created_at: ago(HOUR) });
    const stats = await cleanupMedia({ now: NOW });
    expect(exists(old.id)).toBe(false);
    expect(exists(fresh.id)).toBe(true);
    expect(paths()).toEqual([old.storage_path]);
    expect(stats).toMatchObject({ unattachedRows: 1, unattachedFiles: 1, errors: 0 });
  });

  it("include files of a deleted or edited post, but never one that is attached to a draft or scheduled post", async () => {
    const draft = post("draft");
    const scheduled = post("scheduled");
    const keepA = media({ post_id: draft.id });
    const keepB = media({ post_id: scheduled.id });
    const detached = media({ post_id: null });
    await cleanupMedia({ now: NOW });
    expect(exists(keepA.id) && exists(keepB.id)).toBe(true);
    expect(exists(detached.id)).toBe(false);
    expect(paths()).not.toContain(keepA.storage_path);
  });

  it("keep the file while another post still uses it (re-posting shares files)", async () => {
    const draft = post("draft");
    const shared = "u1/shared/x.jpg";
    const orphan = media({ storage_path: shared });
    const user = media({ storage_path: shared, post_id: draft.id });
    await cleanupMedia({ now: NOW });
    expect(exists(orphan.id)).toBe(false); // the unused row goes
    expect(exists(user.id)).toBe(true);
    expect(paths()).not.toContain(shared); // but the file stays
  });

  it("are retried next time when the file cannot be removed", async () => {
    const orphan = media();
    removeObjects.mockRejectedValueOnce(new Error("storage down"));
    const first = await cleanupMedia({ now: NOW });
    expect(first.errors).toBe(1);
    expect(exists(orphan.id)).toBe(true);
    const second = await cleanupMedia({ now: NOW });
    expect(exists(orphan.id)).toBe(false);
    expect(second.errors).toBe(0);
  });

  it("handles many at once, in batches", async () => {
    for (let i = 0; i < 120; i++) media();
    const stats = await cleanupMedia({ now: NOW });
    expect(stats.unattachedRows).toBe(120);
    expect(fake.tables.post_media).toHaveLength(0);
  });
});

describe("files of finished posts", () => {
  it("are removed 7 days after the post was published, and the row stays as history marked purged", async () => {
    const published = post("published", { published_at: ago(PUBLISHED_TTL_MS + HOUR) });
    const m = media({ post_id: published.id });
    const stats = await cleanupMedia({ now: NOW });
    expect(paths()).toEqual([m.storage_path]);
    expect(state(m.id)).toBe("purged");
    expect(fake.tables.post_media.find((r) => r.id === m.id)).toMatchObject({ post_id: published.id, purged_at: NOW.toISOString() });
    expect(stats.purgedFiles).toBe(1);
  });

  it("are kept until the 7 days have passed", async () => {
    const recent = post("published", { published_at: ago(3 * DAY) });
    const m = media({ post_id: recent.id });
    await cleanupMedia({ now: NOW });
    expect(state(m.id)).toBe("uploaded");
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("are removed for old cancelled posts too", async () => {
    const cancelled = post("cancelled", { updated_at: ago(8 * DAY) });
    const m = media({ post_id: cancelled.id });
    await cleanupMedia({ now: NOW });
    expect(state(m.id)).toBe("purged");
  });

  it("are NEVER removed for draft, scheduled, publishing or failed posts, however old", async () => {
    const kept = (["draft", "scheduled", "publishing", "failed"] as const).map((status) => media({ post_id: post(status).id }));
    await cleanupMedia({ now: NOW });
    expect(kept.map((m) => state(m.id))).toEqual(["uploaded", "uploaded", "uploaded", "uploaded"]);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("stay while a re-post of the same file is still a draft or queued", async () => {
    const old = post("published", { published_at: ago(10 * DAY) });
    const shared = "u1/shared/x.jpg";
    const original = media({ post_id: old.id, storage_path: shared });
    const repost = media({ post_id: post("scheduled").id, storage_path: shared, created_at: ago(HOUR) });
    await cleanupMedia({ now: NOW });
    expect(state(original.id)).toBe("uploaded");
    expect(state(repost.id)).toBe("uploaded");
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("are removed once every post that shares the file has finished", async () => {
    const shared = "u1/shared/x.jpg";
    const a = media({ post_id: post("published", { published_at: ago(10 * DAY) }).id, storage_path: shared });
    const b = media({ post_id: post("published", { published_at: ago(9 * DAY) }).id, storage_path: shared });
    await cleanupMedia({ now: NOW });
    expect(paths()).toEqual([shared]); // the file once
    expect([state(a.id), state(b.id)]).toEqual(["purged", "purged"]);
  });

  it("wait while an unattached upload still points at the same file", async () => {
    const shared = "u1/shared/x.jpg";
    const published = media({ post_id: post("published", { published_at: ago(10 * DAY) }).id, storage_path: shared });
    media({ post_id: null, storage_path: shared, created_at: ago(2 * HOUR) });
    await cleanupMedia({ now: NOW });
    expect(state(published.id)).toBe("uploaded");
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("are safe to run again: a purged row is not touched twice", async () => {
    const published = post("published", { published_at: ago(10 * DAY) });
    media({ post_id: published.id });
    await cleanupMedia({ now: NOW });
    removeObjects.mockClear();
    const again = await cleanupMedia({ now: NOW });
    expect(removeObjects).not.toHaveBeenCalled();
    expect(again.purgedFiles).toBe(0);
  });

  it("leaves a file for the next run when removing it fails", async () => {
    const published = post("published", { published_at: ago(10 * DAY) });
    const m = media({ post_id: published.id });
    removeObjects.mockRejectedValueOnce(new Error("storage down"));
    expect((await cleanupMedia({ now: NOW })).errors).toBe(1);
    expect(state(m.id)).toBe("uploaded");
    expect((await cleanupMedia({ now: NOW })).purgedFiles).toBe(1);
    expect(state(m.id)).toBe("purged");
  });

  it("keeps the file when a re-post copies it after the job looked but before it deleted", async () => {
    const published = post("published", { published_at: ago(10 * DAY) });
    const draft = post("draft");
    const original = media({ post_id: published.id, storage_path: "u1/shared/x.jpg" });
    // The job reads the posts right after listing the file's rows: a copy appears at exactly that moment.
    const realFrom = fake.from;
    let copied = false;
    fake.from = (table: string) => {
      if (table === "posts" && !copied) {
        copied = true;
        media({ post_id: draft.id, storage_path: "u1/shared/x.jpg", created_at: ago(HOUR) });
      }
      return realFrom(table);
    };
    try {
      const stats = await cleanupMedia({ now: NOW });
      expect(stats).toMatchObject({ purgedFiles: 0, errors: 0 });
    } finally { fake.from = realFrom; }
    expect(removeObjects).not.toHaveBeenCalled();
    expect(state(original.id)).toBe("uploaded"); // the claim was undone
    expect(fake.tables.post_media.filter((m) => m.post_id === draft.id).every((m) => m.state === "uploaded")).toBe(true);
  });

  it("pages through many rows without skipping any", async () => {
    const published = post("published", { published_at: ago(10 * DAY) });
    for (let i = 0; i < 130; i++) media({ post_id: published.id, created_at: ago(20 * DAY - i * 1000) });
    const stats = await cleanupMedia({ now: NOW });
    expect(stats.purgedFiles).toBe(130);
    expect(fake.tables.post_media.every((m) => m.state === "purged")).toBe(true);
  });
});

describe("releasesFiles", () => {
  const p = (status: string, over: Record<string, unknown> = {}) => ({ id: "x", status, published_at: null, updated_at: ago(30 * DAY), ...over }) as Parameters<typeof releasesFiles>[0];

  it("only an old published or cancelled post lets go", () => {
    expect(releasesFiles(p("published", { published_at: ago(8 * DAY) }), NOW)).toBe(true);
    expect(releasesFiles(p("published", { published_at: ago(6 * DAY) }), NOW)).toBe(false);
    expect(releasesFiles(p("published", { published_at: null }), NOW)).toBe(false);
    expect(releasesFiles(p("cancelled"), NOW)).toBe(true);
    expect(releasesFiles(p("cancelled", { updated_at: ago(DAY) }), NOW)).toBe(false);
    expect(releasesFiles(undefined, NOW)).toBe(false);
    for (const status of ["draft", "scheduled", "publishing", "failed"]) expect(releasesFiles(p(status), NOW)).toBe(false);
  });
});
