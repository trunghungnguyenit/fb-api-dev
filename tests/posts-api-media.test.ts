import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const processDuePosts = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/csrf", () => ({ isSameOrigin: () => true }));
vi.mock("@/lib/publisher", () => ({ AMBIGUOUS_CODE: "AMBIGUOUS", processDuePosts: (...a: unknown[]) => processDuePosts(...a) }));
vi.mock("@/lib/facebook-posts", () => ({
  deleteFacebookPost: vi.fn(), editFacebookMessage: vi.fn(), isGoneOnFacebook: vi.fn(), markFacebookGone: vi.fn(), recordEvent: vi.fn(),
  FacebookActionError: class extends Error {}
}));

import { POST } from "@/app/api/posts/route";
import { PATCH } from "@/app/api/posts/[id]/route";

const MB = 1024 * 1024;
const PAGE = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const call = (handler: typeof POST, body: unknown) =>
  handler(new NextRequest("http://localhost/api/posts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/posts/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ id }) });

function seedFile(n: number, over: Record<string, unknown> = {}) {
  const row = {
    id: uuid(n), user_id: "u1", post_id: null, kind: "image", storage_path: `u1/${n}/x.jpg`, file_name: "x.jpg", mime: "image/jpeg",
    size_bytes: MB, position: 0, state: "uploaded", facebook_media_id: null, created_at: "2026-10-21T00:00:00Z", ...over
  };
  fake.tables.post_media.push(row);
  return row;
}

beforeEach(() => {
  fake.reset();
  processDuePosts.mockReset();
  processDuePosts.mockResolvedValue([]);
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_name: "Cửa hàng", is_active: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /api/posts with images", () => {
  it("creates a photo post, attaches the file, and schedules it", async () => {
    const file = seedFile(1);
    const res = await call(POST, { pageId: PAGE, message: "Có ảnh", scheduledAt: FUTURE, media: [{ id: file.id }] });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ status: "scheduled", scheduled_at: FUTURE, post_type: "photo" });
    expect(fake.tables.post_media[0]).toMatchObject({ post_id: post.id, position: 0 });
  });

  it("a photo needs no caption, and several images make a 'photos' post in the order given", async () => {
    const a = seedFile(1); const b = seedFile(2);
    const res = await call(POST, { pageId: PAGE, message: "", media: [{ id: b.id }, { id: a.id }] });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ status: "draft", post_type: "photos", message: "" });
    expect(fake.tables.post_media.find((m) => m.id === b.id)).toMatchObject({ post_id: post.id, position: 0 });
    expect(fake.tables.post_media.find((m) => m.id === a.id)).toMatchObject({ post_id: post.id, position: 1 });
  });

  it("still needs a message when there are no images", async () => {
    expect((await call(POST, { pageId: PAGE, message: "", media: [] })).status).toBe(400);
    expect(fake.tables.posts).toHaveLength(0);
  });

  it("is never queued before its images are attached: a post with images starts as a draft", async () => {
    // publish now: the publisher must see a due `scheduled` post with its images ALREADY attached
    const file = seedFile(1);
    let seen: { status: unknown; attached: number } | null = null; // asserted afterwards: the route swallows errors thrown in here
    processDuePosts.mockImplementation(async ({ postId }: { postId: string }) => {
      const row = fake.tables.posts.find((p) => p.id === postId)!;
      seen = { status: row.status, attached: fake.tables.post_media.filter((m) => m.post_id === postId).length };
      return [];
    });
    const res = await call(POST, { pageId: PAGE, message: "x", publishNow: true, media: [{ id: file.id }] });
    expect(res.status).toBe(201);
    expect(seen).toEqual({ status: "scheduled", attached: 1 });
  });

  it("rejects images together with a link, too many images, files that are not usable, and does not create a post", async () => {
    const a = seedFile(1);
    const other = seedFile(2, { user_id: "u2" });
    const pending = seedFile(3, { state: "pending", size_bytes: null });
    const many = Array.from({ length: 11 }, (_, i) => seedFile(10 + i));

    const status = async (body: Record<string, unknown>) => (await call(POST, { pageId: PAGE, message: "x", ...body })).status;
    expect(await status({ linkUrl: "https://x.test", media: [{ id: a.id }] })).toBe(400);
    expect(await status({ media: many.map((m) => ({ id: m.id })) })).toBe(400);
    expect(await status({ media: [{ id: other.id }] })).toBe(404);
    expect(await status({ media: [{ id: pending.id }] })).toBe(409);
    expect(await status({ media: [{ id: uuid(999) }] })).toBe(404);
    expect(fake.tables.posts).toHaveLength(0);
  });

  it("refuses a file already used by another post (no stealing)", async () => {
    const used = seedFile(1, { post_id: uuid(500) });
    expect((await call(POST, { pageId: PAGE, message: "x", media: [{ id: used.id }] })).status).toBe(409);
    expect(fake.tables.posts).toHaveLength(0);
    expect(fake.tables.post_media[0].post_id).toBe(uuid(500));
  });

  it("copies a file of another post when asked to clone it", async () => {
    const original = seedFile(1, { post_id: uuid(500) });
    const res = await call(POST, { pageId: PAGE, message: "bản sao", media: [{ id: original.id, clone: true }] });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    const copies = fake.tables.post_media.filter((m) => m.post_id === post.id);
    expect(copies).toHaveLength(1);
    expect(copies[0].storage_path).toBe(original.storage_path);
    expect(original.post_id).toBe(uuid(500));
  });

  it("text and link posts are unchanged", async () => {
    const res = await call(POST, { pageId: PAGE, message: "chỉ chữ", linkUrl: "https://x.test", scheduledAt: FUTURE });
    expect(await res.json()).toMatchObject({ post: { status: "scheduled", post_type: "link", link_url: "https://x.test" } });
  });
});

describe("PATCH /api/posts/[id] images", () => {
  const POST_ID = uuid(700);
  const seedPost = (over: Record<string, unknown> = {}) => fake.tables.posts.push({
    id: POST_ID, user_id: "u1", page_id: PAGE, message: "chữ", link_url: null, status: "draft", post_type: "photo",
    note: null, last_error_code: null, facebook_post_id: null, facebook_deleted_at: null, scheduled_at: null, ...over
  });

  it("replaces the images of a draft, detaches the dropped file and updates the type", async () => {
    seedPost();
    const keep = seedFile(1, { post_id: POST_ID });
    const drop = seedFile(2, { post_id: POST_ID, position: 1 });
    const added = seedFile(3);
    const res = await patch(POST_ID, { action: "edit", media: [{ id: keep.id }, { id: added.id }] });
    expect(res.status).toBe(200);
    expect(fake.tables.posts[0].post_type).toBe("photos");
    expect(fake.tables.post_media.find((m) => m.id === drop.id)?.post_id).toBeNull();
    expect(fake.tables.post_media.find((m) => m.id === added.id)).toMatchObject({ post_id: POST_ID, position: 1 });
  });

  it("takes a queued post out of the queue while its images change, then puts it back", async () => {
    seedPost({ status: "scheduled", scheduled_at: FUTURE });
    const keep = seedFile(1, { post_id: POST_ID });
    const added = seedFile(2);
    // observe the status at the moment the images are being changed
    const statusDuringChange: string[] = [];
    const realUpdate = fake.from;
    fake.from = (table: string) => {
      const q = realUpdate(table);
      if (table === "post_media") {
        const originalUpdate = q.update.bind(q);
        q.update = (p) => { statusDuringChange.push(String(fake.tables.posts[0].status)); return originalUpdate(p); };
      }
      return q;
    };
    const res = await patch(POST_ID, { action: "edit", media: [{ id: keep.id }, { id: added.id }] });
    fake.from = realUpdate;
    expect(res.status).toBe(200);
    expect(statusDuringChange.length).toBeGreaterThan(0);
    expect(statusDuringChange.every((s) => s === "draft")).toBe(true);
    expect(fake.tables.posts[0]).toMatchObject({ status: "scheduled", post_type: "photos" });
  });

  it("does not touch a post the scheduler has just claimed", async () => {
    seedPost({ status: "publishing" });
    const added = seedFile(1);
    expect((await patch(POST_ID, { action: "edit", media: [{ id: added.id }] })).status).toBe(409);
    expect(fake.tables.post_media[0].post_id).toBeNull();
  });

  it("refuses to add a link to a post that has images, and images to a post that has a link", async () => {
    seedPost();
    seedFile(1, { post_id: POST_ID });
    expect((await patch(POST_ID, { action: "edit", linkUrl: "https://x.test" })).status).toBe(400);

    fake.reset();
    fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", is_active: true });
    seedPost({ post_type: "link", link_url: "https://x.test" });
    const file = seedFile(2);
    expect((await patch(POST_ID, { action: "edit", media: [{ id: file.id }] })).status).toBe(400);
    // ... unless the same edit also drops the link
    expect((await patch(POST_ID, { action: "edit", linkUrl: "", media: [{ id: file.id }] })).status).toBe(200);
    expect(fake.tables.posts[0]).toMatchObject({ post_type: "photo", link_url: null });
  });

  it("does not allow a post to end up with no text and no images", async () => {
    seedPost({ post_type: "text" });
    expect((await patch(POST_ID, { action: "edit", message: "" })).status).toBe(400);
    expect(fake.tables.posts[0].message).toBe("chữ");
  });

  it("an emptied caption is fine for a post that has images", async () => {
    seedPost();
    seedFile(1, { post_id: POST_ID });
    expect((await patch(POST_ID, { action: "edit", message: "" })).status).toBe(200);
    expect(fake.tables.posts[0].message).toBe("");
  });

  it("images of an already published post cannot be changed", async () => {
    seedPost({ status: "published", facebook_post_id: "fb1" });
    const file = seedFile(1);
    expect((await patch(POST_ID, { action: "edit", media: [{ id: file.id }] })).status).toBe(400);
  });
});
