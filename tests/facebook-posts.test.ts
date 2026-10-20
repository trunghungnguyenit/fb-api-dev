import { describe, expect, it } from "vitest";
import { escapeLike } from "@/lib/db";
import { classifyFacebookError, FacebookActionError, isGoneError } from "@/lib/facebook-posts";
import { attemptText, eventLabel, facebookPostUrl, STATUS_FILTERS, statusLabel } from "@/lib/labels";
import { MetaApiError } from "@/lib/meta/client";

const meta = (code: string, httpStatus = 400, subcode?: string) => new MetaApiError("raw meta text", code, httpStatus, { subcode });

describe("isGoneError", () => {
  it("only matches code 100 with subcode 33 (object does not exist)", () => {
    expect(isGoneError(meta("100", 400, "33"))).toBe(true);
    expect(isGoneError(meta("100", 400, "1234"))).toBe(false);
    expect(isGoneError(meta("100"))).toBe(false);
    expect(isGoneError(meta("190", 400, "33"))).toBe(false);
    expect(isGoneError(new Error("100"))).toBe(false);
  });
});

describe("classifyFacebookError", () => {
  it("flags a missing post as gone", () => {
    const e = classifyFacebookError(meta("100", 400, "33"), "read");
    expect(e.code).toBe("FB_POST_GONE");
    expect(e.gone).toBe(true);
  });

  it("maps a dead token to PAGE_PERMISSION_LOST for every operation", () => {
    for (const op of ["read", "edit", "delete"] as const) expect(classifyFacebookError(meta("190"), op).code).toBe("PAGE_PERMISSION_LOST");
  });

  it("turns a refused delete into the manual-delete guidance, not a Page deactivation", () => {
    expect(classifyFacebookError(meta("200", 403), "delete").code).toBe("FB_DELETE_NOT_ALLOWED");
    expect(classifyFacebookError(meta("12345"), "delete").code).toBe("FB_DELETE_NOT_ALLOWED");
  });

  it("turns an unsupported edit into FB_EDIT_REJECTED", () => {
    expect(classifyFacebookError(meta("12345"), "edit").code).toBe("FB_EDIT_REJECTED");
  });

  it("keeps rate limits and outages distinct", () => {
    expect(classifyFacebookError(meta("4"), "edit").code).toBe("FB_RATE_LIMITED");
    expect(classifyFacebookError(meta("2", 500), "read").code).toBe("FB_UNAVAILABLE");
  });

  it("treats timeouts / network errors as temporary and passes our own errors through", () => {
    expect(classifyFacebookError(new TypeError("fetch failed"), "read").code).toBe("FB_UNAVAILABLE");
    const own = new FacebookActionError("PAGE_INACTIVE");
    expect(classifyFacebookError(own, "edit")).toBe(own);
  });
});

describe("escapeLike", () => {
  it("matches user text literally inside ILIKE", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("post labels", () => {
  it("shows deleted posts as deleted on Facebook whatever their status", () => {
    expect(statusLabel("published", true)).toBe("Đã xóa trên Facebook");
    expect(statusLabel("published")).toBe("Đã đăng");
  });

  it("offers a filter for every status plus 'deleted'", () => {
    expect(STATUS_FILTERS.map((s) => s.value)).toEqual(["draft", "scheduled", "publishing", "published", "failed", "cancelled", "deleted"]);
  });

  it("never prints raw Meta codes in attempt history", () => {
    expect(attemptText("failure", "190")).not.toContain("190");
    expect(attemptText("failure", "INTERRUPTED")).toContain("gián đoạn");
    expect(attemptText("success", null)).toBe("Thành công");
    expect(attemptText("ambiguous", "AMBIGUOUS")).toContain("Chưa rõ");
  });

  it("labels events and builds a Facebook link safely", () => {
    expect(eventLabel("edited")).toContain("sửa");
    expect(eventLabel("nonsense")).toBe("Sự kiện");
    expect(facebookPostUrl("123_456")).toBe("https://www.facebook.com/123_456");
    expect(facebookPostUrl("a/b?c")).not.toContain("?");
  });
});
