import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { userDb } from "@/lib/db";
import { logError, newRef, type ErrorCode } from "@/lib/errors";
import { inspectConnection } from "@/lib/connection-health";
import { metaGet } from "@/lib/meta/client";
import { hasScopes, requiredScopes } from "@/lib/meta/scopes";
import { verifyOAuthState } from "@/lib/oauth-state";
import { fetchAllManagedPages } from "@/lib/meta/pages";
import { syncConnectionPages } from "@/lib/page-sync";

export const runtime = "nodejs";

const STATE_COOKIE = "meta_oauth_state";
const STATE_COOKIE_PATH = "/api/auth/facebook";

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function back(path: string) {
  const response = NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));
  response.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
  return response;
}

/** Redirects to /pages with a user-facing error code; technical detail goes to the log under a reference. */
function backWithError(code: ErrorCode, detail?: unknown) {
  const ref = newRef();
  logError(code, ref, detail ?? "(no technical detail)", "warn");
  return back(`/pages?error=${code}&ref=${ref}`);
}

async function fetchJson(url: URL) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

export async function GET(request: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.NEXT_PUBLIC_APP_URL));

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!state || !stateCookie || !safeEqual(state, stateCookie) || !verifyOAuthState(state, user.id)) return backWithError("OAUTH_STATE_INVALID");
  // The user declined on Facebook: no `code`, but a valid state.
  if (params.get("error") || !code) return backWithError("FB_OAUTH_DENIED");

  try {
    const tokenUrl = new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", env.META_APP_ID);
    tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", env.META_OAUTH_REDIRECT_URI);
    tokenUrl.searchParams.set("code", code);
    const shortLived = await fetchJson(tokenUrl);
    if (!shortLived.ok || !shortLived.body.access_token) {
      return backWithError("FB_TOKEN_EXCHANGE_FAILED", shortLived.body?.error ?? shortLived.body);
    }

    // Long-lived user token: page tokens derived from it do not expire. A short-lived fallback
    // would make every scheduled post fail hours later, so fail the connect instead.
    const exchangeUrl = new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/oauth/access_token`);
    exchangeUrl.searchParams.set("grant_type", "fb_exchange_token");
    exchangeUrl.searchParams.set("client_id", env.META_APP_ID);
    exchangeUrl.searchParams.set("client_secret", env.META_APP_SECRET);
    exchangeUrl.searchParams.set("fb_exchange_token", shortLived.body.access_token);
    const longLived = await fetchJson(exchangeUrl);
    if (!longLived.ok || !longLived.body.access_token) {
      return backWithError("FB_TOKEN_EXCHANGE_FAILED", longLived.body?.error ?? longLived.body);
    }
    const userToken: string = longLived.body.access_token;
    const expiresIn = Number(longLived.body.expires_in ?? 0);

    const me = await metaGet<{ id: string; name?: string }>("me", userToken, { fields: "id,name" });
    // Facebook lets users untick permissions on the consent screen: record what was really granted and
    // refuse a connection that could never publish (it would list Pages, then fail on every post).
    const permissions = await metaGet<{ data?: { permission: string; status: string }[] }>("me/permissions", userToken);
    const granted = (permissions.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
    if (!hasScopes(granted, requiredScopes())) return backWithError("FB_SCOPES_MISSING");

    // Complete list (cursor pagination); a partial list would wrongly deactivate Pages below.
    const pages = await fetchAllManagedPages(userToken);

    const { data: connection, error: connectionError } = await userDb(user.id).connections.upsert({
      meta_user_id: me.id,
      meta_user_name: me.name ?? null,
      user_token_encrypted: encryptSecret(userToken),
      token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scopes: granted,
      // A fresh token: whatever the last health check said about the previous one no longer applies.
      token_is_valid: true,
      token_checked_at: null,
      data_access_expires_at: null,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,meta_user_id" }).select("id").single();

    if (connectionError || !connection) return backWithError("DB_ERROR", connectionError);
    // Record when this token's data access ends right away (best effort: the daily check does it otherwise).
    await inspectConnection({ id: connection.id, user_id: user.id, meta_user_name: me.name ?? null, scopes: granted }, userToken);

    const sync = await syncConnectionPages(user.id, connection.id, pages);
    const query = new URLSearchParams({ connected: "1" });
    if (sync.failed) query.set("page_errors", String(sync.failed));
    if (sync.deactivated) query.set("deactivated", String(sync.deactivated));
    return back(`/pages?${query}`);
  } catch (e) {
    return backWithError("FB_CONNECT_FAILED", e);
  }
}
