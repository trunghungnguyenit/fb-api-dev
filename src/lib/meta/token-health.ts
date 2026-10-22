// What Meta's `debug_token` says about a user token, and what we do with it. Pure module (safe for client and
// server). Nothing here talks to Meta or the database.
import { ENABLED_FEATURES, featureAccess, FEATURES, type Feature } from "@/lib/meta/scopes";

/** The `data` object of GET /debug_token (only the fields we read). Times are epoch SECONDS; 0 = never. */
export type DebugTokenData = {
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
};

export type TokenInfo = {
  /** null = Meta did not give a verdict (treat as unknown, never as invalid). */
  valid: boolean | null;
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  scopes: string[];
};

const epochToDate = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null);

export function parseDebugToken(data: DebugTokenData | null | undefined): TokenInfo {
  if (!data || typeof data.is_valid !== "boolean") return { valid: null, expiresAt: null, dataAccessExpiresAt: null, scopes: [] };
  return {
    valid: data.is_valid,
    expiresAt: epochToDate(data.expires_at),
    dataAccessExpiresAt: epochToDate(data.data_access_expires_at),
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === "string") : []
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The user is warned at these many days left (each warning is sent once per expiry date). */
export const EXPIRY_WARN_DAYS = [7, 3, 1] as const;
export type ExpiryBucket = (typeof EXPIRY_WARN_DAYS)[number];

export type ExpiryWarning = {
  /** Whole days left, rounded up (0 = it ends today / already ended). */
  days: number;
  bucket: ExpiryBucket;
  /** Date the access ends (yyyy-mm-dd): part of the dedupe key, so a renewed token can warn again later. */
  expiryDay: string;
};

/**
 * Both the token itself and the data access it grants can end; whichever comes first is what the user needs to
 * act on. Returns null when nothing ends within the warning window.
 */
export function expiryWarning(
  info: { expiresAt: Date | null; dataAccessExpiresAt: Date | null }, now: Date = new Date()
): ExpiryWarning | null {
  const ends = [info.expiresAt, info.dataAccessExpiresAt].filter((d): d is Date => d !== null);
  if (!ends.length) return null;
  const first = new Date(Math.min(...ends.map((d) => d.getTime())));
  const days = Math.max(0, Math.ceil((first.getTime() - now.getTime()) / DAY_MS));
  // The tightest warning level that covers the days left (2 days left is the "3 days" warning).
  const bucket = [...EXPIRY_WARN_DAYS].sort((a, b) => a - b).find((limit) => days <= limit);
  return bucket ? { days, bucket, expiryDay: first.toISOString().slice(0, 10) } : null;
}

/**
 * Enabled features that WERE usable with the permissions we had stored and no longer are: the user took a
 * permission back on Facebook. A permission that was never granted is the user's choice and is not reported.
 */
export function revokedFeatures(before: readonly string[] | null | undefined, after: readonly string[]): Feature[] {
  if (!before?.length || !after.length) return []; // nothing to compare, or Meta gave no list
  const was = featureAccess(before);
  const now = featureAccess(after);
  return ENABLED_FEATURES.filter((f) => was[f].available && !now[f].available);
}

export const featureLabels = (features: readonly Feature[]) => features.map((f) => FEATURES[f].label);

export type ConnectionAttention = { kind: "invalid" } | { kind: "expiring"; days: number } | null;

/** What the Fanpage screen should tell the user about a connection, from what we stored at the last check. */
export function connectionAttention(
  row: { token_is_valid: boolean | null; token_expires_at: string | null; data_access_expires_at: string | null },
  now: Date = new Date()
): ConnectionAttention {
  if (row.token_is_valid === false) return { kind: "invalid" };
  const warning = expiryWarning({
    expiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
    dataAccessExpiresAt: row.data_access_expires_at ? new Date(row.data_access_expires_at) : null
  }, now);
  return warning ? { kind: "expiring", days: warning.days } : null;
}
