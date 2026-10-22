import { beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
vi.mock("@/lib/db", () => ({
  userDb: () => ({ notifications: { insert } }),
  rows: (data: unknown) => (Array.isArray(data) ? data : [])
}));

import { notify } from "@/lib/notifications";
import { dedupeKeys, describeNotification, NOTIFICATION_TYPES } from "@/lib/notification-text";

describe("describeNotification", () => {
  it("names the Fanpage and links to the post for a failed publish, using only our own message", () => {
    const t = describeNotification({ type: "PUBLISH_FAILED", code: "FB_RATE_LIMITED", post_id: "p1" }, "Cửa hàng A");
    expect(t.title).toBe("Đăng bài thất bại trên Cửa hàng A");
    expect(t.detail).toContain("Facebook đang giới hạn");
    expect(t.href).toBe("/posts/p1");
  });

  it("never shows raw or unknown codes", () => {
    const t = describeNotification({ type: "PUBLISH_FAILED", code: "raw Meta text (#200) Permissions error" }, null);
    expect(t.detail).toBe("Đăng bài thất bại. Vui lòng thử lại.");
    expect(t.detail).not.toContain("Meta");
    expect(t.title).toBe("Đăng bài thất bại");
  });

  it("warns that an ambiguous post may already be live", () => {
    const t = describeNotification({ type: "PUBLISH_AMBIGUOUS", post_id: "p2" }, "Page B");
    expect(t.detail).toContain("có thể đã lên Facebook");
    expect(t.href).toBe("/posts/p2");
  });

  it("sends Page and connection problems to the Fanpage screen", () => {
    expect(describeNotification({ type: "PAGE_ACCESS_LOST" }, "Page C")).toMatchObject({ title: "Page C đã mất quyền truy cập", href: "/pages" });
    expect(describeNotification({ type: "REAUTH_REQUIRED", params: { connectionName: "An" } }).title).toBe("Cần xác thực lại Facebook (An)");
    const expiring = describeNotification({ type: "TOKEN_EXPIRING", params: { days: 6.4 } });
    expect(expiring.detail).toContain("sau khoảng 6 ngày");
    expect(describeNotification({ type: "SCOPES_MISSING", params: { features: ["bình luận"] } }, "Page D").detail).toContain("Để dùng bình luận");
  });

  it("copes with an unknown type from a newer or older version", () => {
    expect(describeNotification({ type: "SOMETHING_NEW" })).toEqual({ title: "Thông báo", detail: "", href: "/" });
  });

  it("covers every type the database allows", () => {
    for (const type of NOTIFICATION_TYPES) expect(describeNotification({ type }).title).not.toBe("Thông báo");
  });
});

describe("dedupeKeys", () => {
  it("separates a new failure of the same post but not a repeat of the same one", () => {
    expect(dedupeKeys.publishFailed("p", 1)).toBe(dedupeKeys.publishFailed("p", 1));
    expect(dedupeKeys.publishFailed("p", 1)).not.toBe(dedupeKeys.publishFailed("p", 2));
  });

  it("allows one Page-lost notification per Page per day", () => {
    expect(dedupeKeys.pageAccessLost("pg", "2026-10-21")).not.toBe(dedupeKeys.pageAccessLost("pg", "2026-10-22"));
  });

  it("ignores the order of features", () => {
    expect(dedupeKeys.scopesMissing("c", ["b", "a"], "2026-10-21")).toBe(dedupeKeys.scopesMissing("c", ["a", "b"], "2026-10-21"));
  });

  it("warns again for a renewed token, but only once per warning level of the same expiry", () => {
    expect(dedupeKeys.tokenExpiring("c", 7, "2027-01-18")).toBe(dedupeKeys.tokenExpiring("c", 7, "2027-01-18"));
    expect(dedupeKeys.tokenExpiring("c", 7, "2027-01-18")).not.toBe(dedupeKeys.tokenExpiring("c", 3, "2027-01-18"));
    expect(dedupeKeys.tokenExpiring("c", 7, "2027-01-18")).not.toBe(dedupeKeys.tokenExpiring("c", 7, "2027-04-18"));
  });
});

describe("notify", () => {
  beforeEach(() => { insert.mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("stores only codes and parameters", async () => {
    insert.mockResolvedValue({ error: null });
    await notify("u1", { type: "PUBLISH_FAILED", dedupeKey: "k", pageId: "pg", postId: "po", code: "FB_REJECTED" });
    expect(insert).toHaveBeenCalledWith({ type: "PUBLISH_FAILED", dedupe_key: "k", page_id: "pg", post_id: "po", code: "FB_REJECTED", params: {} });
  });

  it("treats a repeated event (unique violation) as done, without logging an error", async () => {
    insert.mockResolvedValue({ error: { code: "23505" } });
    await expect(notify("u1", { type: "PAGE_ACCESS_LOST", dedupeKey: "k" })).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("never throws, so it cannot break the job that detected the problem", async () => {
    insert.mockResolvedValue({ error: { code: "XX000" } });
    await expect(notify("u1", { type: "PAGE_ACCESS_LOST", dedupeKey: "k" })).resolves.toBeUndefined();
    insert.mockRejectedValue(new Error("network down"));
    await expect(notify("u1", { type: "PAGE_ACCESS_LOST", dedupeKey: "k2" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
