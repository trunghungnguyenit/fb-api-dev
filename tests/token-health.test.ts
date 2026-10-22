import { beforeEach, describe, expect, it, vi } from "vitest";

const debug = vi.fn();
const update = vi.fn();
const eq = vi.fn();
const notify = vi.fn();
vi.mock("@/lib/meta/client", () => ({ metaGet: (...args: unknown[]) => debug(...args) }));
vi.mock("@/lib/db", () => ({ userDb: () => ({ connections: { update: (patch: unknown) => { update(patch); return { eq }; } } }) }));
vi.mock("@/lib/notifications", () => ({ notify: (...args: unknown[]) => notify(...args) }));

import { inspectConnection } from "@/lib/connection-health";
import { connectionAttention, expiryWarning, parseDebugToken, revokedFeatures } from "@/lib/meta/token-health";

const NOW = new Date("2026-10-21T00:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

describe("parseDebugToken", () => {
  it("reads validity, both end dates and scopes; 0 means never", () => {
    const info = parseDebugToken({ is_valid: true, expires_at: 0, data_access_expires_at: 1800341288, scopes: ["pages_show_list", 7 as unknown as string] });
    expect(info.valid).toBe(true);
    expect(info.expiresAt).toBeNull();
    expect(info.dataAccessExpiresAt?.toISOString()).toBe(new Date(1800341288 * 1000).toISOString());
    expect(info.scopes).toEqual(["pages_show_list"]);
  });

  it("gives no verdict when Meta did not say is_valid", () => {
    for (const data of [null, undefined, {}, { scopes: ["a"] }]) expect(parseDebugToken(data).valid).toBeNull();
    expect(parseDebugToken({ is_valid: false }).valid).toBe(false);
  });
});

describe("expiryWarning", () => {
  const warn = (days: number) => expiryWarning({ expiresAt: null, dataAccessExpiresAt: inDays(days) }, NOW);

  it("is silent while the end is far away or unknown", () => {
    expect(warn(30)).toBeNull();
    expect(warn(7.2)).toBeNull();
    expect(expiryWarning({ expiresAt: null, dataAccessExpiresAt: null }, NOW)).toBeNull();
  });

  it("uses the tightest level that covers the days left", () => {
    expect(warn(7)?.bucket).toBe(7);
    expect(warn(5)?.bucket).toBe(7);
    expect(warn(3)?.bucket).toBe(3);
    expect(warn(2.5)?.bucket).toBe(3);
    expect(warn(1)?.bucket).toBe(1);
    expect(warn(0.2)).toMatchObject({ bucket: 1, days: 1 });
    expect(warn(-2)).toMatchObject({ bucket: 1, days: 0 });
  });

  it("goes by whichever of token and data access ends first, and names that date", () => {
    const w = expiryWarning({ expiresAt: inDays(2), dataAccessExpiresAt: inDays(60) }, NOW);
    expect(w).toMatchObject({ bucket: 3, days: 2, expiryDay: "2026-10-23" });
  });
});

describe("revokedFeatures", () => {
  const ALL = ["pages_show_list", "pages_manage_posts", "pages_read_engagement"];

  it("reports a feature the user took back", () => {
    expect(revokedFeatures(ALL, ["pages_show_list", "pages_manage_posts"])).toEqual(["readEngagement"]);
    expect(revokedFeatures(ALL, ["pages_read_engagement"])).toEqual(["publish"]);
  });

  it("does not report what was never granted, or when there is nothing to compare", () => {
    expect(revokedFeatures(["pages_show_list", "pages_manage_posts"], ["pages_show_list", "pages_manage_posts"])).toEqual([]);
    expect(revokedFeatures(null, ["pages_show_list"])).toEqual([]);
    expect(revokedFeatures([], ["pages_show_list"])).toEqual([]);
    expect(revokedFeatures(ALL, [])).toEqual([]);
  });
});

describe("connectionAttention", () => {
  const row = (over: Partial<Parameters<typeof connectionAttention>[0]> = {}) =>
    ({ token_is_valid: true, token_expires_at: null, data_access_expires_at: null, ...over });

  it("flags a dead token first, then an approaching end, else nothing", () => {
    expect(connectionAttention(row({ token_is_valid: false }), NOW)).toEqual({ kind: "invalid" });
    expect(connectionAttention(row({ data_access_expires_at: inDays(4).toISOString() }), NOW)).toEqual({ kind: "expiring", days: 4 });
    expect(connectionAttention(row({ data_access_expires_at: inDays(90).toISOString() }), NOW)).toBeNull();
    expect(connectionAttention(row({ token_is_valid: null }), NOW)).toBeNull();
  });
});

describe("inspectConnection", () => {
  const connection = { id: "c1", user_id: "u1", meta_user_name: "An", scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"] };
  const goodScopes = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "public_profile"];

  beforeEach(() => {
    for (const m of [debug, update, eq, notify]) m.mockReset();
    eq.mockResolvedValue({ error: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("asks Meta with the app token and records a healthy token without notifying", async () => {
    debug.mockResolvedValue({ data: { is_valid: true, expires_at: 0, data_access_expires_at: seconds(inDays(80)), scopes: goodScopes } });
    expect(await inspectConnection(connection, "USER-TOKEN", NOW)).toBe(true);
    expect(debug).toHaveBeenCalledWith("debug_token", "test-app-id|test-app-secret", { input_token: "USER-TOKEN" });
    expect(update).toHaveBeenCalledWith({
      token_is_valid: true, token_checked_at: NOW.toISOString(), token_expires_at: null, scopes: goodScopes,
      data_access_expires_at: inDays(80).toISOString()
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a dead token as false and records it, leaving the Pages to the caller", async () => {
    debug.mockResolvedValue({ data: { is_valid: false } });
    expect(await inspectConnection(connection, "t", NOW)).toBe(false);
    expect(update).toHaveBeenCalledWith({ token_checked_at: NOW.toISOString(), token_is_valid: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("never calls a token dead because Meta could not be asked", async () => {
    debug.mockRejectedValue(new Error("network down"));
    expect(await inspectConnection(connection, "t", NOW)).toBeNull();
    debug.mockResolvedValue({ data: {} });
    expect(await inspectConnection(connection, "t", NOW)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("warns once data access is about to end", async () => {
    debug.mockResolvedValue({ data: { is_valid: true, data_access_expires_at: seconds(inDays(2)), scopes: goodScopes } });
    await inspectConnection(connection, "t", NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({
      type: "TOKEN_EXPIRING", params: { connectionName: "An", days: 2 }, dedupeKey: "token-expiring:c1:2026-10-23:3"
    }));
  });

  it("tells the user when a permission was taken back", async () => {
    debug.mockResolvedValue({ data: { is_valid: true, scopes: ["pages_show_list", "pages_manage_posts"] } });
    await inspectConnection(connection, "t", NOW);
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({
      type: "SCOPES_MISSING", params: { connectionName: "An", features: ["xem số liệu tương tác của bài"] }
    }));
  });

  it("still returns the verdict if recording it fails", async () => {
    debug.mockResolvedValue({ data: { is_valid: true, scopes: goodScopes } });
    eq.mockResolvedValue({ error: { code: "XX000" } });
    expect(await inspectConnection(connection, "t", NOW)).toBe(true);
  });
});
