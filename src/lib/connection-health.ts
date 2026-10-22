import { env } from "@/lib/env";
import { userDb } from "@/lib/db";
import { metaGet } from "@/lib/meta/client";
import { dedupeKeys } from "@/lib/notification-text";
import { notify } from "@/lib/notifications";
import { expiryWarning, featureLabels, parseDebugToken, revokedFeatures, type DebugTokenData } from "@/lib/meta/token-health";

export type ConnectionInfo = {
  id: string;
  user_id: string;
  meta_user_name?: string | null;
  scopes?: string[] | null;
};

/** Asks Meta about a user token. The app's own token (id|secret) authorises the question. */
export async function debugToken(userToken: string): Promise<DebugTokenData | null> {
  const res = await metaGet<{ data?: DebugTokenData }>("debug_token", `${env.META_APP_ID}|${env.META_APP_SECRET}`, { input_token: userToken });
  return res.data ?? null;
}

/**
 * Checks one connection's user token with Meta and records the verdict, so problems are known BEFORE a post
 * fails: validity, when the token / data access ends, and which permissions are still granted.
 *
 * Returns true (valid), false (Meta says the token is dead) or null (no verdict: Meta unreachable, rate
 * limited, or an answer we cannot read). null must never be treated as "dead": the caller falls back to its
 * other checks. When valid, it also warns the user as the end of access approaches and when a permission was
 * taken back.
 */
export async function inspectConnection(connection: ConnectionInfo, userToken: string, now: Date = new Date()): Promise<boolean | null> {
  let info;
  try {
    info = parseDebugToken(await debugToken(userToken));
  } catch (e) {
    console.warn(`debug_token failed for connection ${connection.id}:`, e);
    return null;
  }
  if (info.valid === null) return null;

  const db = userDb(connection.user_id);
  const patch: Record<string, unknown> = { token_checked_at: now.toISOString(), token_is_valid: info.valid };
  if (info.valid) {
    patch.token_expires_at = info.expiresAt?.toISOString() ?? null;
    patch.data_access_expires_at = info.dataAccessExpiresAt?.toISOString() ?? null;
    if (info.scopes.length) patch.scopes = info.scopes;
  }
  const { error } = await db.connections.update(patch).eq("id", connection.id);
  if (error) console.error(`recording token health failed for connection ${connection.id}:`, error);
  if (!info.valid) return false;

  const params = { connectionName: connection.meta_user_name ?? undefined };
  const warning = expiryWarning(info, now);
  if (warning) {
    await notify(connection.user_id, {
      type: "TOKEN_EXPIRING", dedupeKey: dedupeKeys.tokenExpiring(connection.id, warning.bucket, warning.expiryDay),
      params: { ...params, days: warning.days }
    });
  }
  const revoked = revokedFeatures(connection.scopes, info.scopes);
  if (revoked.length) {
    await notify(connection.user_id, {
      type: "SCOPES_MISSING", dedupeKey: dedupeKeys.scopesMissing(connection.id, revoked, now.toISOString().slice(0, 10)),
      params: { ...params, features: featureLabels(revoked) }
    });
  }
  return true;
}
