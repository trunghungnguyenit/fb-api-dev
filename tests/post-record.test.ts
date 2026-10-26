import { describe, expect, it } from "vitest";
import { canRemoveRecord } from "@/lib/post-record";

describe("canRemoveRecord", () => {
  it("allows every post that was never published", () => {
    for (const status of ["draft", "scheduled", "failed", "cancelled"]) expect(canRemoveRecord(status, false)).toBe(true);
  });

  it("allows a published post only once it is gone from Facebook", () => {
    expect(canRemoveRecord("published", true)).toBe(true);
    expect(canRemoveRecord("published", false)).toBe(false); // live: deleting it is a Facebook action, not a record clean-up
  });

  it("never while the post is being published, or for an unknown status", () => {
    expect(canRemoveRecord("publishing", false)).toBe(false);
    expect(canRemoveRecord("publishing", true)).toBe(false);
    expect(canRemoveRecord("something-else", false)).toBe(false);
  });
});
