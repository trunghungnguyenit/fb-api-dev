import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, messageFor, newRef, REF_PATTERN, withRef } from "@/lib/errors";
import { postErrorText, taskLabel, truncate } from "@/lib/labels";

describe("messageFor", () => {
  it("returns the Vietnamese message for a known code", () => {
    expect(messageFor("PAGE_INACTIVE")).toBe(ERROR_MESSAGES.PAGE_INACTIVE);
  });

  it("never leaks unknown / raw backend text", () => {
    expect(messageFor("(#200) Permissions error")).toBe(ERROR_MESSAGES.UNEXPECTED);
    expect(messageFor("__proto__")).toBe(ERROR_MESSAGES.UNEXPECTED);
    expect(messageFor(null)).toBe(ERROR_MESSAGES.UNEXPECTED);
  });

  it("uses the supplied fallback", () => {
    expect(messageFor("190", "PUBLISH_FAILED")).toBe(ERROR_MESSAGES.PUBLISH_FAILED);
  });

  it("has a non-empty message for every code", () => {
    for (const [code, text] of Object.entries(ERROR_MESSAGES)) expect(text.length, code).toBeGreaterThan(5);
  });
});

describe("references", () => {
  it("newRef matches REF_PATTERN", () => {
    for (let i = 0; i < 50; i++) expect(newRef()).toMatch(REF_PATTERN);
  });

  it("withRef only appends a well-formed reference", () => {
    expect(withRef("Lỗi", "ABCDEF12")).toBe("Lỗi (Mã tham chiếu: ABCDEF12)");
    expect(withRef("Lỗi", "<script>")).toBe("Lỗi");
    expect(withRef("Lỗi", null)).toBe("Lỗi");
  });
});

describe("labels", () => {
  it("shows a generic publish error for raw codes stored by older versions", () => {
    expect(postErrorText("(#10) App does not have permission")).toBe(ERROR_MESSAGES.PUBLISH_FAILED);
    expect(postErrorText("AMBIGUOUS")).toBe(ERROR_MESSAGES.AMBIGUOUS);
    expect(postErrorText(null)).toBeNull();
  });

  it("truncates by code point, not UTF-16 unit", () => {
    expect(truncate("ab🚀cd", 3)).toBe("ab🚀…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("translates known tasks and passes unknown ones through", () => {
    expect(taskLabel("CREATE_CONTENT")).toBe("Tạo nội dung");
    expect(taskLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
