import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const createUploadTarget = vi.fn();
const statObject = vi.fn();
const readHead = vi.fn();
const removeObjects = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/media/storage", () => ({
  createUploadTarget: (...a: unknown[]) => createUploadTarget(...a),
  statObject: (...a: unknown[]) => statObject(...a),
  readHead: (...a: unknown[]) => readHead(...a),
  removeObjects: (...a: unknown[]) => removeObjects(...a),
  mediaPath: (u: string, id: string, name: string) => `${u}/${id}/${name}`
}));

import { applyMedia, confirmUpload, discardMedia, issueUpload, MediaConflict, resolveMedia } from "@/lib/media/service";
import { userDb } from "@/lib/db";
import { buildLimits } from "@/lib/media/limits";

const MB = 1024 * 1024;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const limits = buildLimits({});
const media = () => fake.tables.post_media;

function seedMedia(over: Record<string, unknown> = {}) {
  const row = {
    id: `m${media().length + 1}`, user_id: "u1", post_id: null, kind: "image", storage_path: `u1/m/x.jpg`, file_name: "x.jpg",
    mime: "image/jpeg", size_bytes: 1 * MB, position: 0, facebook_media_id: null, state: "uploaded", created_at: "2026-10-01T00:00:00Z", ...over
  };
  media().push(row);
  return row;
}

beforeEach(() => {
  fake.reset();
  for (const m of [createUploadTarget, statObject, readHead, removeObjects]) m.mockReset();
  createUploadTarget.mockResolvedValue({ url: "https://storage.test/upload?token=t", token: "t" });
  removeObjects.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("issueUpload (before the upload)", () => {
  const request = { kind: "image" as const, mime: "image/png", size: 2 * MB, name: "Ảnh đẹp.PNG" };

  it("records a pending upload under the user's own folder and hands out a signed URL", async () => {
    const result = await issueUpload("u1", request, limits);
    expect(result).toMatchObject({ ok: true, uploadUrl: "https://storage.test/upload?token=t" });
    expect(media()).toHaveLength(1);
    expect(media()[0]).toMatchObject({ user_id: "u1", state: "pending", mime: "image/png" });
    expect(String(media()[0].storage_path)).toMatch(/^u1\/[0-9a-f-]{36}\/Anh-dep\.png$/);
    expect(createUploadTarget).toHaveBeenCalledWith(media()[0].storage_path);
  });

  it("refuses an over-limit or unsupported file before anything is stored", async () => {
    const big = await issueUpload("u1", { ...request, size: 10 * MB + 1 }, limits);
    expect(big).toMatchObject({ ok: false, problem: { code: "MEDIA_TOO_LARGE", status: 413 } });
    expect(big.ok === false && big.problem.message).toContain("10 MB");
    expect(await issueUpload("u1", { ...request, mime: "image/webp" }, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TYPE_INVALID" } });
    expect(media()).toHaveLength(0);
    expect(createUploadTarget).not.toHaveBeenCalled();
  });

  it("uses the configured limit, so raising it needs no code change", async () => {
    const raised = buildLimits({ MEDIA_MAX_IMAGE_MB: "20", MEDIA_MAX_FILE_MB: "50" });
    expect(await issueUpload("u1", { ...request, size: 15 * MB }, raised)).toMatchObject({ ok: true });
  });

  it("caps how many uploads can wait unattached", async () => {
    for (let i = 0; i < 60; i++) seedMedia({ state: "pending" });
    expect(await issueUpload("u1", request, limits)).toMatchObject({ ok: false, problem: { code: "RATE_LIMITED", status: 429 } });
    // another user is not affected
    expect(await issueUpload("u2", request, limits)).toMatchObject({ ok: true });
  });

  it("removes the row again when no signed URL could be made", async () => {
    createUploadTarget.mockRejectedValue(new Error("storage down"));
    expect(await issueUpload("u1", request, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_STORAGE_ERROR" } });
    expect(media()).toHaveLength(0);
  });
});

describe("confirmUpload (after the upload)", () => {
  it("accepts what really arrived and records its true size", async () => {
    const row = seedMedia({ state: "pending", size_bytes: null });
    statObject.mockResolvedValue({ size: 3 * MB, mime: "image/jpeg" });
    readHead.mockResolvedValue(JPEG);
    const result = await confirmUpload("u1", row.id, limits);
    expect(result).toMatchObject({ ok: true, media: { state: "uploaded", size_bytes: 3 * MB } });
    expect(media()[0]).toMatchObject({ state: "uploaded", size_bytes: 3 * MB });
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("rejects and deletes a file much bigger than what was declared", async () => {
    const row = seedMedia({ state: "pending", size_bytes: null });
    statObject.mockResolvedValue({ size: 40 * MB, mime: "image/jpeg" });
    readHead.mockResolvedValue(JPEG);
    expect(await confirmUpload("u1", row.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TOO_LARGE", status: 413 } });
    expect(removeObjects).toHaveBeenCalledWith([row.storage_path]);
    expect(media()[0].state).toBe("failed");
  });

  it("rejects a file whose content is not what was declared, or not an image at all", async () => {
    const png = seedMedia({ state: "pending", size_bytes: null, mime: "image/jpeg" });
    statObject.mockResolvedValue({ size: MB, mime: "image/jpeg" });
    readHead.mockResolvedValue(PNG);
    expect(await confirmUpload("u1", png.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_MISMATCH" } });

    const html = seedMedia({ state: "pending", size_bytes: null });
    readHead.mockResolvedValue(Uint8Array.from(Buffer.from("<script>alert(1)</script>")));
    expect(await confirmUpload("u1", html.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_TYPE_INVALID" } });
    expect(media().map((m) => m.state)).toEqual(["failed", "failed"]);
  });

  it("asks the client to upload again when nothing is in storage, leaving the row usable", async () => {
    const row = seedMedia({ state: "pending", size_bytes: null });
    statObject.mockResolvedValue(null);
    expect(await confirmUpload("u1", row.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_NOT_UPLOADED", status: 409 } });
    expect(media()[0].state).toBe("pending");
  });

  it("is safe to repeat, never confirms another user's upload, and reports storage trouble as such", async () => {
    const row = seedMedia({ state: "uploaded" });
    expect(await confirmUpload("u1", row.id, limits)).toMatchObject({ ok: true });
    expect(statObject).not.toHaveBeenCalled();
    expect(await confirmUpload("someone-else", row.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_NOT_FOUND", status: 404 } });

    const pending = seedMedia({ state: "pending", size_bytes: null });
    statObject.mockRejectedValue(new Error("storage down"));
    expect(await confirmUpload("u1", pending.id, limits)).toMatchObject({ ok: false, problem: { code: "MEDIA_STORAGE_ERROR", status: 502 } });
  });
});

describe("discardMedia", () => {
  it("removes an unattached upload and its file", async () => {
    const row = seedMedia({ state: "uploaded" });
    expect(await discardMedia("u1", row.id)).toEqual({ ok: true });
    expect(media()).toHaveLength(0);
    expect(removeObjects).toHaveBeenCalledWith([row.storage_path]);
  });

  it("keeps the file while another row still uses it (re-posting shares files)", async () => {
    const row = seedMedia({ state: "uploaded", storage_path: "u1/shared/x.jpg" });
    seedMedia({ post_id: "post-1", storage_path: "u1/shared/x.jpg" });
    expect(await discardMedia("u1", row.id)).toEqual({ ok: true });
    expect(media()).toHaveLength(1);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("refuses a file that belongs to a post, and one that is not the user's", async () => {
    const attached = seedMedia({ post_id: "post-1" });
    expect(await discardMedia("u1", attached.id)).toMatchObject({ ok: false, problem: { code: "MEDIA_IN_USE" } });
    const other = seedMedia({ user_id: "u2" });
    expect(await discardMedia("u1", other.id)).toMatchObject({ ok: false, problem: { code: "MEDIA_NOT_FOUND" } });
    expect(media()).toHaveLength(2);
  });
});

describe("resolveMedia", () => {
  const db = () => userDb("u1");

  it("accepts uploaded files in the given order and derives the post type", async () => {
    const a = seedMedia(); const b = seedMedia();
    const one = await resolveMedia(db(), [{ id: a.id }], { limits });
    expect(one).toMatchObject({ ok: true, value: { postType: "photo" } });
    const two = await resolveMedia(db(), [{ id: b.id }, { id: a.id }], { limits });
    expect(two.ok && two.value.rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(two.ok && two.value.postType).toBe("photos");
    expect(await resolveMedia(db(), [], { linkUrl: "https://x.test", limits })).toMatchObject({ ok: true, value: { postType: "link", rows: [] } });
  });

  it("refuses files that are missing, someone else's, unfinished, purged or already used", async () => {
    const other = seedMedia({ user_id: "u2" });
    const pending = seedMedia({ state: "pending", size_bytes: null });
    const purged = seedMedia({ state: "purged" });
    const used = seedMedia({ post_id: "post-9" });
    const code = async (id: string, clone = false) => {
      const r = await resolveMedia(db(), [{ id, clone }], { limits });
      return r.ok ? "ok" : r.problem.code;
    };
    expect(await code("00000000-0000-0000-0000-000000000000")).toBe("MEDIA_NOT_FOUND");
    expect(await code(other.id)).toBe("MEDIA_NOT_FOUND");
    expect(await code(pending.id)).toBe("MEDIA_NOT_UPLOADED");
    expect(await code(purged.id)).toBe("MEDIA_PURGED");
    expect(await code(used.id)).toBe("MEDIA_IN_USE");
    expect(await code(used.id, true)).toBe("ok"); // copying a file that is on another post is what "clone" is for
  });

  it("lets a post keep its own files when it is edited, but cannot copy an unattached upload", async () => {
    const own = seedMedia({ post_id: "post-1" });
    expect(await resolveMedia(db(), [{ id: own.id }], { ownPostId: "post-1", limits })).toMatchObject({ ok: true });
    const free = seedMedia();
    expect(await resolveMedia(db(), [{ id: free.id, clone: true }], { limits })).toMatchObject({ ok: false, problem: { code: "MEDIA_NOT_FOUND" } });
  });

  it("enforces the per-post limits with the configured numbers", async () => {
    const files = Array.from({ length: 11 }, () => seedMedia());
    const tooMany = await resolveMedia(db(), files.map((f) => ({ id: f.id })), { limits });
    expect(tooMany).toMatchObject({ ok: false, problem: { code: "MEDIA_TOO_MANY", status: 400 } });
    expect(tooMany.ok === false && tooMany.problem.message).toContain("10 ảnh");

    const big = Array.from({ length: 6 }, () => seedMedia({ size_bytes: 9 * MB }));
    expect(await resolveMedia(db(), big.map((f) => ({ id: f.id })), { limits })).toMatchObject({ ok: false, problem: { code: "MEDIA_TOTAL_TOO_LARGE" } });
    expect(await resolveMedia(db(), big.map((f) => ({ id: f.id })), { limits: buildLimits({ MEDIA_MAX_IMAGES_TOTAL_MB: "100" }) })).toMatchObject({ ok: true });
  });

  it("does not allow images together with a link, or the same file twice", async () => {
    const a = seedMedia();
    expect(await resolveMedia(db(), [{ id: a.id }], { linkUrl: "https://x.test", limits })).toMatchObject({ ok: false, problem: { code: "MEDIA_WITH_LINK" } });
    expect(await resolveMedia(db(), [{ id: a.id }, { id: a.id }], { limits })).toMatchObject({ ok: false, problem: { code: "INVALID_REQUEST" } });
  });
});

describe("applyMedia", () => {
  const db = () => userDb("u1");
  const resolve = async (refs: { id: string; clone?: boolean }[], ownPostId?: string) => {
    const r = await resolveMedia(db(), refs, { ownPostId, limits });
    if (!r.ok) throw new Error(`resolve failed: ${r.problem.code}`);
    return r.value;
  };

  it("attaches uploads to the post in order", async () => {
    const a = seedMedia(); const b = seedMedia();
    await applyMedia(db(), "post-1", await resolve([{ id: b.id }, { id: a.id }]));
    expect(media().find((m) => m.id === b.id)).toMatchObject({ post_id: "post-1", position: 0 });
    expect(media().find((m) => m.id === a.id)).toMatchObject({ post_id: "post-1", position: 1 });
  });

  it("copies cloned files as new rows that share the stored file", async () => {
    const original = seedMedia({ post_id: "post-1", storage_path: "u1/shared/x.jpg" });
    await applyMedia(db(), "post-2", await resolve([{ id: original.id, clone: true }]));
    const copies = media().filter((m) => m.post_id === "post-2");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ storage_path: "u1/shared/x.jpg", state: "uploaded", size_bytes: MB, position: 0 });
    expect(copies[0].facebook_media_id ?? null).toBeNull(); // Facebook's photo id belongs to the original upload, not to the copy
    expect(copies[0].id).not.toBe(original.id);
    expect(media().find((m) => m.id === original.id)?.post_id).toBe("post-1");
  });

  it("when a post is edited, detaches the files that were dropped and keeps the order", async () => {
    const keep = seedMedia({ post_id: "post-1", position: 0 });
    const drop = seedMedia({ post_id: "post-1", position: 1 });
    const added = seedMedia();
    await applyMedia(db(), "post-1", await resolve([{ id: added.id }, { id: keep.id }], "post-1"));
    expect(media().find((m) => m.id === drop.id)).toMatchObject({ post_id: null }); // left for the cleanup job
    expect(media().find((m) => m.id === added.id)).toMatchObject({ post_id: "post-1", position: 0 });
    expect(media().find((m) => m.id === keep.id)).toMatchObject({ post_id: "post-1", position: 1 });
  });

  it("refuses to take a file somebody else attached in the meantime", async () => {
    const a = seedMedia();
    const resolved = await resolve([{ id: a.id }]);
    media().find((m) => m.id === a.id)!.post_id = "someone-elses-post"; // lost the race
    await expect(applyMedia(db(), "post-1", resolved)).rejects.toBeInstanceOf(MediaConflict);
  });

  it("is all or nothing: a conflict half-way leaves the post with the media it had", async () => {
    const keep = seedMedia({ post_id: "post-1", position: 0 });
    const drop = seedMedia({ post_id: "post-1", position: 1 });
    const added = seedMedia();
    const stolen = seedMedia();
    const resolved = await resolve([{ id: added.id }, { id: keep.id }, { id: stolen.id }], "post-1");
    media().find((m) => m.id === stolen.id)!.post_id = "someone-elses-post"; // lost the race on the last file

    await expect(applyMedia(db(), "post-1", resolved)).rejects.toBeInstanceOf(MediaConflict);

    expect(media().find((m) => m.id === drop.id)).toMatchObject({ post_id: "post-1", position: 1 }); // not detached
    expect(media().find((m) => m.id === keep.id)).toMatchObject({ post_id: "post-1", position: 0 }); // order restored
    expect(media().find((m) => m.id === added.id)).toMatchObject({ post_id: null }); // not left half-attached
    expect(media().find((m) => m.id === stolen.id)).toMatchObject({ post_id: "someone-elses-post" });
  });

  it("is all or nothing: a failure while detaching also takes back the new files and copies", async () => {
    const drop = seedMedia({ post_id: "post-1", position: 0 });
    const added = seedMedia();
    const source = seedMedia({ post_id: "post-9", storage_path: "u1/shared/y.jpg" });
    const resolved = await resolve([{ id: added.id }, { id: source.id, clone: true }], "post-1");
    // The detach is the only update without a `state` filter: make that one fail.
    const realFrom = fake.from;
    fake.from = (table: string) => {
      const q = realFrom(table) as unknown as { update: (p: Record<string, unknown>) => unknown; in: (c: string, v: unknown[]) => unknown };
      const update = q.update.bind(q);
      q.update = (patch) => {
        const query = update(patch) as { in: (c: string, v: unknown[]) => unknown };
        if (patch.post_id === null && patch.position === 0) {
          const inFn = query.in.bind(query);
          query.in = (c, v) => (v.includes(drop.id) ? Promise.resolve({ data: null, error: { message: "db down" } }) : inFn(c, v));
        }
        return query;
      };
      return q as ReturnType<typeof realFrom>;
    };
    try {
      await expect(applyMedia(db(), "post-1", resolved)).rejects.toMatchObject({ message: "db down" });
    } finally { fake.from = realFrom; }

    expect(media().find((m) => m.id === drop.id)).toMatchObject({ post_id: "post-1" });
    expect(media().find((m) => m.id === added.id)).toMatchObject({ post_id: null });
    expect(media().filter((m) => m.post_id === "post-1")).toHaveLength(1); // the copy of `source` is gone again
  });

  it("refuses to copy a file the cleanup job has just purged, and leaves no copy behind", async () => {
    const source = seedMedia({ post_id: "post-1", storage_path: "u1/shared/x.jpg" });
    const resolved = await resolve([{ id: source.id, clone: true }]);
    media().find((m) => m.id === source.id)!.state = "purged";
    await expect(applyMedia(db(), "post-2", resolved)).rejects.toBeInstanceOf(MediaConflict);
    expect(media().filter((m) => m.post_id === "post-2")).toHaveLength(0);
  });
});
