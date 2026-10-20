import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/csrf";
import { createOAuthState, verifyOAuthState } from "@/lib/oauth-state";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as NextRequest;

describe("isSameOrigin", () => {
  it("trusts Sec-Fetch-Site when present", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("falls back to comparing Origin with the Host the browser used", () => {
    expect(isSameOrigin(req({ origin: "https://app.example", host: "app.example" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://evil.example", host: "app.example" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "https://app.example", "x-forwarded-host": "app.example", host: "internal:3000" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "not a url", host: "app.example" }))).toBe(false);
  });

  it("allows non-browser clients that send neither header", () => {
    expect(isSameOrigin(req({}))).toBe(true);
  });
});

describe("OAuth state", () => {
  it("verifies for the user it was issued to", () => {
    expect(verifyOAuthState(createOAuthState("user-a"), "user-a")).toBe(true);
  });

  it("is useless in another user's session", () => {
    expect(verifyOAuthState(createOAuthState("user-a"), "user-b")).toBe(false);
  });

  it("rejects tampered or malformed values", () => {
    const [nonce, sig] = createOAuthState("user-a").split(".");
    expect(verifyOAuthState(`${nonce}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`, "user-a")).toBe(false);
    expect(verifyOAuthState(nonce, "user-a")).toBe(false);
    expect(verifyOAuthState("", "user-a")).toBe(false);
  });

  it("issues a fresh state each time", () => {
    expect(createOAuthState("user-a")).not.toBe(createOAuthState("user-a"));
  });
});
