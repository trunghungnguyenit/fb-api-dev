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
  deleteFacebookPost: vi.fn(), markFacebookGone: vi.fn(), recordEvent: vi.fn(), FacebookActionError: class extends Error {}
}));

import { POST as repost } from "@/app/api/posts/[id]/repost/route";
import { POST as bulk } from "@/app/api/posts/bulk/route";

const MB = 1024 * 1024;
const PAGE = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const call = (body: unknown) => repost(
  new NextRequest(`http://localhost/api/posts/${SOURCE}/repost`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  { params: Promise.resolve({ id: SOURCE }) }
);

function seedSource(postType: string, images: { state?: string }[] = [], over: Record<string, unknown> = {}) {
  fake.tables.posts.push({
    id: SOURCE, user_id: "u1", page_id: PAGE, message: "Chú thích", link_url: null, status: "failed", post_type: postType,
    facebook_post_id: null, facebook_deleted_at: null, last_error_code: "FB_REJECTED", reposted_from: null, created_at: "2026-10-01T00:00:00Z", ...over
  });
  images.forEach((img, i) => fake.tables.post_media.push({
    id: uuid(i + 1), user_id: "u1", post_id: SOURCE, kind: "image", storage_path: `u1/shared/${i}.jpg`, file_name: `${i}.jpg`, mime: "image/jpeg",
    size_bytes: MB, position: i, state: img.state ?? "uploaded", facebook_media_id: "fb-photo-old", created_at: "2026-10-01T00:00:00Z"
  }));
}

beforeEach(() => {
  fake.reset();
  processDuePosts.mockReset();
  processDuePosts.mockResolvedValue([]);
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_name: "Cửa hàng", is_active: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("re-posting a post with images (clone)", () => {
  it("gives the copy its own rows for the same stored files, in order, and publishes only after they are attached", async () => {
    seedSource("photos", [{}, {}]);
    let seen: { status: unknown; attached: number } | null = null;
    processDuePosts.mockImplementation(async ({ postId }: { postId: string }) => {
      const row = fake.tables.posts.find((p) => p.id === postId)!;
      seen = { status: row.status, attached: fake.tables.post_media.filter((m) => m.post_id === postId).length };
      return [];
    });
    const res = await call({ mode: "clone", message: "Chú thích", pageIds: [PAGE], when: "now" });
    expect(res.status).toBe(200);
    const copy = fake.tables.posts.find((p) => p.id !== SOURCE)!;
    expect(copy).toMatchObject({ post_type: "photos", reposted_from: SOURCE, status: "scheduled" });
    const rows = fake.tables.post_media.filter((m) => m.post_id === copy.id).sort((a, b) => Number(a.position) - Number(b.position));
    expect(rows.map((r) => r.storage_path)).toEqual(["u1/shared/0.jpg", "u1/shared/1.jpg"]);
    expect(rows.every((r) => !r.facebook_media_id)).toBe(true); // Facebook's old photo ids are not reused
    expect(fake.tables.post_media.filter((m) => m.post_id === SOURCE)).toHaveLength(2); // the original keeps its own
    expect(seen).toEqual({ status: "scheduled", attached: 2 });
  });

  it("with an empty caption is fine when the original has images", async () => {
    seedSource("photo", [{}], { message: "" });
    const res = await call({ mode: "clone", message: "", pageIds: [PAGE], when: "draft" });
    expect(res.status).toBe(200);
    expect(fake.tables.posts.find((p) => p.id !== SOURCE)).toMatchObject({ post_type: "photo", status: "draft", message: "" });
  });

  it("is refused when the original's images were cleaned up, and nothing is created", async () => {
    seedSource("photo", [{ state: "purged" }]);
    const res = await call({ mode: "clone", message: "x", pageIds: [PAGE], when: "draft" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("MEDIA_PURGED");
    expect(fake.tables.posts).toHaveLength(1);
  });

  it("does not accept a link together with images", async () => {
    seedSource("photo", [{}]);
    const res = await call({ mode: "clone", message: "x", linkUrl: "https://x.test", pageIds: [PAGE], when: "draft" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MEDIA_WITH_LINK");
  });

  it("a text post still needs text, and is cloned as before", async () => {
    seedSource("text");
    expect((await call({ mode: "clone", message: "", pageIds: [PAGE], when: "draft" })).status).toBe(400);
    expect((await call({ mode: "clone", message: "Chú thích", pageIds: [PAGE], when: "draft" })).status).toBe(200);
    expect(fake.tables.posts.find((p) => p.id !== SOURCE)).toMatchObject({ post_type: "text" });
  });
});

describe("bulk re-post", () => {
  const bulkCall = (ids: string[], when: "draft" | "now") => bulk(
    new NextRequest("http://localhost/api/posts/bulk", { method: "POST", body: JSON.stringify({ action: "repost", ids, when }), headers: { "content-type": "application/json" } })
  );

  it("carries images over for posts that have them and skips posts whose images are gone", async () => {
    seedSource("photo", [{}]);
    const gone = uuid(900);
    fake.tables.posts.push({ id: gone, user_id: "u1", page_id: PAGE, message: "mất ảnh", link_url: null, status: "failed", post_type: "photo",
      facebook_post_id: null, facebook_deleted_at: null, last_error_code: "FB_REJECTED", reposted_from: null, created_at: "2026-10-01T00:00:00Z" });
    fake.tables.post_media.push({ id: uuid(901), user_id: "u1", post_id: gone, kind: "image", storage_path: "u1/gone.jpg", mime: "image/jpeg", size_bytes: MB, position: 0, state: "purged" });
    const text = uuid(902);
    fake.tables.posts.push({ id: text, user_id: "u1", page_id: PAGE, message: "chỉ chữ", link_url: null, status: "failed", post_type: "text",
      facebook_post_id: null, facebook_deleted_at: null, last_error_code: "FB_REJECTED", reposted_from: null, created_at: "2026-10-01T00:00:00Z" });

    const res = await bulkCall([SOURCE, gone, text], "draft");
    const body = await res.json();
    expect(body.done).toBe(2);
    expect(body.skipped).toEqual([expect.objectContaining({ id: gone, code: "MEDIA_PURGED" })]);
    const copies = fake.tables.posts.filter((p) => p.reposted_from);
    expect(copies.map((c) => c.post_type).sort()).toEqual(["photo", "text"]);
    const photoCopy = copies.find((c) => c.post_type === "photo")!;
    expect(fake.tables.post_media.filter((m) => m.post_id === photoCopy.id)).toHaveLength(1);
  });
});
