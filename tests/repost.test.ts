import { describe, expect, it } from "vitest";
import {
  isLiveOnFacebook, pagesOverLimit, REPOST_LIMIT_PER_DAY, repostModes, repostRoot, repostSchedule, type RepostSource
} from "@/lib/repost";

const post = (over: Partial<RepostSource>): RepostSource => ({
  status: "published", facebook_post_id: "1_2", facebook_deleted_at: null, last_error_code: null, ...over
});

describe("repostModes", () => {
  it("a post deleted on Facebook can be re-posted in place or copied", () => {
    expect(repostModes(post({ facebook_deleted_at: "2026-10-19T13:53:24Z" }))).toEqual(["same_row", "clone"]);
  });

  it("a live post can only be copied or replaced; it is never rewritten in place", () => {
    const modes = repostModes(post({}));
    expect(modes).toEqual(["clone", "replace"]);
    expect(modes).not.toContain("same_row");
  });

  it("failed and cancelled posts can be re-posted in place or copied", () => {
    expect(repostModes(post({ status: "failed", facebook_post_id: null }))).toEqual(["same_row", "clone"]);
    expect(repostModes(post({ status: "cancelled", facebook_post_id: null }))).toEqual(["same_row", "clone"]);
  });

  it("offers nothing while a post is still in flight or not yet sent", () => {
    for (const status of ["draft", "scheduled", "publishing"]) expect(repostModes(post({ status }))).toEqual([]);
  });

  it("cannot replace a live post whose Facebook id is unknown", () => {
    expect(repostModes(post({ facebook_post_id: null }))).toEqual([]);
  });
});

describe("isLiveOnFacebook", () => {
  it("is true only for a published post that has not been deleted", () => {
    expect(isLiveOnFacebook(post({}))).toBe(true);
    expect(isLiveOnFacebook(post({ facebook_deleted_at: "2026-10-19T00:00:00Z" }))).toBe(false);
    expect(isLiveOnFacebook(post({ status: "failed" }))).toBe(false);
  });
});

describe("repostRoot", () => {
  it("points a copy at the original, never at another copy", () => {
    expect(repostRoot({ id: "copy-2", reposted_from: "original" })).toBe("original");
    expect(repostRoot({ id: "original", reposted_from: null })).toBe("original");
  });
});

describe("pagesOverLimit", () => {
  it("blocks a Fanpage once it reached the 24h limit, per Fanpage", () => {
    const counts = new Map([["pageA", REPOST_LIMIT_PER_DAY], ["pageB", REPOST_LIMIT_PER_DAY - 1]]);
    expect(pagesOverLimit(counts, ["pageA", "pageB", "pageC"])).toEqual(["pageA"]);
  });

  it("allows a Fanpage that was never re-posted to", () => {
    expect(pagesOverLimit(new Map(), ["pageA"])).toEqual([]);
  });
});

describe("repostSchedule", () => {
  const now = Date.parse("2026-10-19T10:00:00.000Z");

  it("'now' is a post that is already due", () => {
    const s = repostSchedule("now", now);
    expect(s.status).toBe("scheduled");
    expect(new Date(s.scheduled_at as string).getTime()).toBeLessThan(now);
  });

  it("'draft' has no schedule", () => {
    expect(repostSchedule("draft", now)).toEqual({ status: "draft", scheduled_at: null });
  });

  it("a date is scheduled for exactly that time", () => {
    expect(repostSchedule("2026-10-20T01:00:00.000Z", now)).toEqual({ status: "scheduled", scheduled_at: "2026-10-20T01:00:00.000Z" });
  });
});
