// Which Facebook permissions each feature needs. Pure module (safe for client and server).
//
// Features are gated by what the user actually granted (stored in facebook_connections.scopes), so a user who
// declined an optional permission can still use everything else. Only `required` features block connecting.

export type Feature = "publish" | "readEngagement" | "comments" | "insights";

export const FEATURES: Record<Feature, { label: string; scopes: readonly string[]; required: boolean }> = {
  publish: { label: "đăng bài", scopes: ["pages_show_list", "pages_manage_posts"], required: true },
  readEngagement: { label: "xem số liệu tương tác của bài", scopes: ["pages_read_engagement"], required: false },
  comments: { label: "quản lý bình luận", scopes: ["pages_read_user_content", "pages_manage_engagement"], required: false },
  // Page Insights also needs the person to hold the ANALYZE task on the Page (checked per Page, see lib/insights.ts).
  insights: { label: "xem thống kê Fanpage (Insights)", scopes: ["read_insights", "pages_read_engagement"], required: false }
};

/** Features the app has code for. Only their permissions are requested in the Facebook login dialog. */
export const ENABLED_FEATURES: readonly Feature[] = ["publish", "readEngagement", "comments", "insights"];

/** Reading other people's comments, and acting on them (reply, hide, delete), are separate permissions. */
export const COMMENT_READ_SCOPES = ["pages_read_user_content"] as const;
export const COMMENT_MANAGE_SCOPES = ["pages_manage_engagement"] as const;

/** Comma-separated `scope` value for the Facebook login dialog. */
export function oauthScopes(): string {
  return [...new Set(ENABLED_FEATURES.flatMap((f) => FEATURES[f].scopes))].join(",");
}

/** Permissions a connection must have, or it could never publish. */
export function requiredScopes(): string[] {
  return [...new Set(ENABLED_FEATURES.filter((f) => FEATURES[f].required).flatMap((f) => FEATURES[f].scopes))];
}

export function missingScopes(granted: readonly string[] | null | undefined, needed: readonly string[]): string[] {
  const have = new Set(granted ?? []);
  return needed.filter((scope) => !have.has(scope));
}

export function hasScopes(granted: readonly string[] | null | undefined, needed: readonly string[]) {
  return missingScopes(granted, needed).length === 0;
}

export type FeatureAccess = { available: boolean; missing: string[] };

/** For each feature: usable with the granted permissions, and which permissions are missing if not. */
export function featureAccess(granted: readonly string[] | null | undefined): Record<Feature, FeatureAccess> {
  const entry = (feature: Feature): FeatureAccess => {
    const missing = missingScopes(granted, FEATURES[feature].scopes);
    return { available: missing.length === 0, missing };
  };
  return { publish: entry("publish"), readEngagement: entry("readEngagement"), comments: entry("comments"), insights: entry("insights") };
}

/** Enabled features the granted permissions do not cover (what a "grant more permissions" prompt should list). */
export function unavailableFeatures(granted: readonly string[] | null | undefined): Feature[] {
  const access = featureAccess(granted);
  return ENABLED_FEATURES.filter((f) => !access[f].available);
}
