import { describe, expect, it } from "vitest";
import { COMMENT_MANAGE_SCOPES, COMMENT_READ_SCOPES, ENABLED_FEATURES, featureAccess, FEATURES, hasScopes, missingScopes, oauthScopes, requiredScopes, unavailableFeatures } from "@/lib/meta/scopes";

describe("scopes", () => {
  it("asks for exactly the permissions of the features the app has code for", () => {
    expect(oauthScopes().split(",").sort()).toEqual([
      "pages_manage_engagement", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_show_list"
    ]);
    for (const feature of ENABLED_FEATURES) for (const scope of FEATURES[feature].scopes) expect(oauthScopes()).toContain(scope);
  });

  it("reading comments and acting on them are separate permissions", () => {
    expect(COMMENT_READ_SCOPES).toEqual(["pages_read_user_content"]);
    expect(COMMENT_MANAGE_SCOPES).toEqual(["pages_manage_engagement"]);
    for (const scope of [...COMMENT_READ_SCOPES, ...COMMENT_MANAGE_SCOPES]) expect(FEATURES.comments.scopes).toContain(scope);
  });

  it("only publishing is required to connect", () => {
    expect(requiredScopes().sort()).toEqual(["pages_manage_posts", "pages_show_list"]);
  });

  it("finds missing permissions, tolerating no data", () => {
    expect(missingScopes(["a"], ["a", "b"])).toEqual(["b"]);
    expect(missingScopes(null, ["a"])).toEqual(["a"]);
    expect(missingScopes(undefined, [])).toEqual([]);
    expect(hasScopes(["a", "b"], ["b"])).toBe(true);
    expect(hasScopes([], ["b"])).toBe(false);
  });

  it("gates each feature on what was really granted", () => {
    const access = featureAccess(["pages_show_list", "pages_manage_posts"]);
    expect(access.publish).toEqual({ available: true, missing: [] });
    expect(access.readEngagement).toEqual({ available: false, missing: ["pages_read_engagement"] });
    expect(access.comments.available).toBe(false);
    expect(access.comments.missing).toEqual(["pages_read_user_content", "pages_manage_engagement"]);
  });

  it("lists enabled features that need more permissions (and not disabled ones)", () => {
    const all = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement"];
    expect(unavailableFeatures(all)).toEqual([]);
    expect(unavailableFeatures(["pages_show_list", "pages_manage_posts", "pages_read_engagement"])).toEqual(["comments"]);
    expect(unavailableFeatures(["pages_show_list", "pages_manage_posts"])).toEqual(["readEngagement", "comments"]);
    expect(unavailableFeatures([])).toEqual(["publish", "readEngagement", "comments"]);
  });
});
