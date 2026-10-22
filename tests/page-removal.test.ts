import { describe, expect, it } from "vitest";
import { CANCELLED_ON_REMOVAL, excludeRemoved, summarizeImpact } from "@/lib/page-removal";

describe("summarizeImpact", () => {
  it("counts what will be cancelled and what is kept", () => {
    const impact = summarizeImpact([
      { status: "draft", n: 3, ambiguous: 0 },
      { status: "scheduled", n: 5, ambiguous: 0 },
      { status: "failed", n: 4, ambiguous: 1 },
      { status: "published", n: 12, ambiguous: 0 },
      { status: "cancelled", n: 2, ambiguous: 0 }
    ]);
    expect(impact).toMatchObject({ drafts: 3, scheduled: 5, failed: 3, ambiguousKept: 1, published: 12, cancelled: 2, willCancel: 11, total: 26 });
  });

  it("never cancels a failed post whose outcome is unknown (it may be live)", () => {
    const impact = summarizeImpact([{ status: "failed", n: 2, ambiguous: 2 }]);
    expect(impact.willCancel).toBe(0);
    expect(impact.ambiguousKept).toBe(2);
  });

  it("accepts the string counts Postgres returns for bigint, and an empty Fanpage", () => {
    expect(summarizeImpact([{ status: "scheduled", n: "7", ambiguous: "0" }]).willCancel).toBe(7);
    expect(summarizeImpact([])).toMatchObject({ willCancel: 0, total: 0, published: 0 });
  });

  it("does not let an ambiguous marker on a non-failed row inflate the kept count", () => {
    expect(summarizeImpact([{ status: "draft", n: 1, ambiguous: 1 }]).ambiguousKept).toBe(0);
  });

  it("only cancels statuses that were never on Facebook", () => {
    expect([...CANCELLED_ON_REMOVAL]).toEqual(["draft", "scheduled", "failed"]);
    for (const s of ["published", "publishing", "cancelled"]) expect(CANCELLED_ON_REMOVAL).not.toContain(s);
  });
});

describe("excludeRemoved", () => {
  it("keeps sync from re-adding a Fanpage the user removed", () => {
    const fromFacebook = [{ id: "100", name: "A" }, { id: "200", name: "B" }, { id: "300", name: "C" }];
    expect(excludeRemoved(fromFacebook, new Set(["200"])).map((p) => p.id)).toEqual(["100", "300"]);
    expect(excludeRemoved(fromFacebook, new Set()).length).toBe(3);
  });
});
