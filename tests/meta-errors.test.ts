import { describe, expect, it } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import { describeMetaError, isPermissionError } from "@/lib/meta/pages";

const err = (code: string, httpStatus = 400) => new MetaApiError("raw meta text", code, httpStatus);

describe("describeMetaError", () => {
  it("treats only dead-token codes as lost permission", () => {
    for (const code of ["190", "102", "467"]) expect(describeMetaError(err(code))).toBe("PAGE_PERMISSION_LOST");
  });

  it("does NOT treat per-action / app-level permission errors as a dead Page", () => {
    // These must never deactivate a Page: one bad post or an app-review state would take the whole queue offline.
    for (const code of ["10", "200", "283", "459"]) expect(describeMetaError(err(code, 403))).toBe("FB_PERMISSION_DENIED");
  });

  it("maps rate limits, duplicates, content and outages", () => {
    expect(describeMetaError(err("368"))).toBe("FB_TEMP_BLOCKED");
    for (const code of ["4", "17", "32", "613"]) expect(describeMetaError(err(code))).toBe("FB_RATE_LIMITED");
    expect(describeMetaError(err("506"))).toBe("FB_DUPLICATE");
    expect(describeMetaError(err("100"))).toBe("FB_CONTENT_REJECTED");
    expect(describeMetaError(err("1"))).toBe("FB_UNAVAILABLE");
    expect(describeMetaError(err("999", 503))).toBe("FB_UNAVAILABLE");
  });

  it("falls back to a generic rejection and never exposes Meta's text", () => {
    expect(describeMetaError(err("12345"))).toBe("FB_REJECTED");
  });
});

describe("isPermissionError", () => {
  it("is true only for a MetaApiError with a dead-token code", () => {
    expect(isPermissionError(err("190"))).toBe(true);
    expect(isPermissionError(err("200"))).toBe(false);
    expect(isPermissionError(new Error("190"))).toBe(false);
  });
});
