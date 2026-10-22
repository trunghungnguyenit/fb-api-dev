import { beforeEach, describe, expect, it, vi } from "vitest";

// A query-builder stand-in: every method returns the same object, and awaiting it yields `result`.
function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  const self = new Proxy(q, {
    get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(result) : () => self)
  });
  return self;
}

const inspect = vi.fn();
const fetchPages = vi.fn();
const notify = vi.fn();
const pageUpdates: unknown[] = [];
const connectionUpdates: unknown[] = [];
let activePages: { id: string }[] = [];

vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "USER-TOKEN", encryptSecret: (v: string) => v }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/connection-health", () => ({ inspectConnection: (...a: unknown[]) => inspect(...a) }));
vi.mock("@/lib/notifications", () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock("@/lib/meta/pages", async (original) => ({
  ...(await original<typeof import("@/lib/meta/pages")>()),
  fetchAllManagedPages: (...a: unknown[]) => fetchPages(...a)
}));
vi.mock("@/lib/db", () => ({
  rows: (d: unknown) => (Array.isArray(d) ? d : []),
  one: (d: unknown) => d ?? null,
  userDb: () => ({
    pages: {
      select: () => chain({ data: activePages, error: null }),
      update: (patch: unknown) => { pageUpdates.push(patch); return chain({ data: [{ id: "switched" }], error: null }); }
    },
    posts: { update: () => chain({ error: null }) },
    connections: { update: (patch: unknown) => { connectionUpdates.push(patch); return chain({ error: null }); } }
  })
}));

import { checkConnection } from "@/lib/page-sync";
import { MetaApiError } from "@/lib/meta/client";

const connection = { id: "c1", user_id: "u1", user_token_encrypted: "x", meta_user_name: "An", scopes: [], token_is_valid: true };

describe("checkConnection", () => {
  beforeEach(() => {
    for (const m of [inspect, fetchPages, notify]) m.mockReset();
    pageUpdates.length = 0;
    connectionUpdates.length = 0;
    activePages = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("switches the Pages off and sends ONE re-authentication notice when Meta says the token is dead", async () => {
    inspect.mockResolvedValue(false);
    const result = await checkConnection(connection);
    expect(result).toEqual({ saved: 0, failed: 0, deactivated: 3 });
    expect(fetchPages).not.toHaveBeenCalled();
    expect(pageUpdates).toHaveLength(3);
    expect(connectionUpdates).toEqual([expect.objectContaining({ token_is_valid: false })]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "REAUTH_REQUIRED", params: { connectionName: "An" } }));
  });

  it("does not repeat the notice for a connection already known to be dead with nothing left to switch off", async () => {
    inspect.mockResolvedValue(false);
    activePages = [];
    await checkConnection({ ...connection, token_is_valid: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("still catches a dead token through the Pages call when Meta gave no verdict", async () => {
    inspect.mockResolvedValue(null);
    fetchPages.mockRejectedValue(new MetaApiError("expired", "190", 401));
    const result = await checkConnection(connection);
    expect(result.deactivated).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not switch anything off for an ordinary Meta failure", async () => {
    inspect.mockResolvedValue(null);
    fetchPages.mockRejectedValue(new MetaApiError("server error", "2", 500));
    await expect(checkConnection(connection)).rejects.toThrow("server error");
    expect(pageUpdates).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
