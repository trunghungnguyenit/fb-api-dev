import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
const deactivatePage = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => fake.from(t) } }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => `token-of-${v}`, encryptSecret: (v: string) => v }));
vi.mock("@/lib/page-sync", () => ({ deactivatePage: (...a: unknown[]) => deactivatePage(...a) }));

import { FacebookActionError, runWithPageToken } from "@/lib/facebook-posts";
import { MetaApiError } from "@/lib/meta/client";

const PAGE = "11111111-1111-4111-8111-111111111111";
const warn = vi.spyOn(console, "warn");
const error = vi.spyOn(console, "error");

beforeEach(() => {
  fake.reset();
  deactivatePage.mockReset();
  fake.tables.facebook_pages.push({ id: PAGE, user_id: "u1", page_id: "fb1", page_access_token_encrypted: "enc", is_active: true, removed_at: null });
  warn.mockReset().mockImplementation(() => {});
  error.mockReset().mockImplementation(() => {});
});

const run = (fn: () => Promise<unknown>) => runWithPageToken("u1", PAGE, "read", "something", fn).then(() => null, (e: FacebookActionError) => e);

describe("how a failed read of Facebook is logged", () => {
  it("is a warning, with what FACEBOOK said, when the user is told to fix it themselves (a permission to grant)", async () => {
    const failure = await run(async () => {
      throw new FacebookActionError("GUEST_PERMISSION_DENIED", false, new MetaApiError("(#10) Requires pages_read_user_content", "10", 403, { subcode: "2" }));
    });
    expect(failure?.code).toBe("GUEST_PERMISSION_DENIED");
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("GUEST_PERMISSION_DENIED");
    expect(warn.mock.calls[0][1]).toMatchObject({ code: "10", subcode: "2", message: "(#10) Requires pages_read_user_content" });
  });

  it("is a warning for a raw refusal Facebook gave that becomes such a message", async () => {
    await run(async () => { throw new MetaApiError("(#200) denied", "200", 403); });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ code: "200" });
  });

  it("stays an error for what nobody expected: an outage, or a failure that is not Facebook's", async () => {
    await run(async () => { throw new Error("network down"); });
    await run(async () => { throw new MetaApiError("server error", "2", 500); });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("never logs the token", async () => {
    await run(async () => { throw new MetaApiError("(#10) denied", "10", 403); });
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("token-of-enc");
  });
});
