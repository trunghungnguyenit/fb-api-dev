import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildKeyring, decryptWith, encryptWith, keyIdOf } from "@/lib/crypto-core";

const K1 = "1".repeat(64);
const K2 = "2".repeat(64);
const keys = (obj: Record<string, string>) => JSON.stringify(obj);

/** What the app wrote before key versions existed: `iv.tag.ciphertext`, no prefix. */
function legacyEncrypt(hexKey: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((p) => p.toString("base64url")).join(".");
}

describe("buildKeyring", () => {
  it("keeps the single-key setup working as key 1", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEY: K1 });
    expect(ring.currentId).toBe("1");
    expect(encryptWith(ring, "secret").startsWith("v1.")).toBe(true);
  });

  it("requires a current key id when versioned keys are set", () => {
    expect(() => buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "1": K1 }) })).toThrow(/APP_ENCRYPTION_KEY_ID/);
  });

  it("rejects a current key id that is not configured", () => {
    expect(() => buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "1": K1 }), APP_ENCRYPTION_KEY_ID: "2" })).toThrow(/not one of/);
  });

  it("rejects missing configuration, malformed JSON and malformed keys without leaking the key", () => {
    expect(() => buildKeyring({})).toThrow(/Set APP_ENCRYPTION_KEY/);
    expect(() => buildKeyring({ APP_ENCRYPTION_KEYS: "{nope", APP_ENCRYPTION_KEY_ID: "1" })).toThrow(/JSON/);
    expect(() => buildKeyring({ APP_ENCRYPTION_KEYS: "[]", APP_ENCRYPTION_KEY_ID: "1" })).toThrow(/JSON object/);
    const bad = "not-hex-but-secret-ish";
    try { buildKeyring({ APP_ENCRYPTION_KEY: bad }); } catch (e) { expect(String(e)).not.toContain(bad); }
    expect(() => buildKeyring({ APP_ENCRYPTION_KEY: bad })).toThrow(/64 hex/);
  });

  it("rejects key ids that would break the ciphertext format", () => {
    expect(() => buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "a.b": K1 }), APP_ENCRYPTION_KEY_ID: "a.b" })).toThrow(/Invalid encryption key id/);
  });

  it("treats APP_ENCRYPTION_KEY as legacy key 1 next to a newer current key", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEY: K1, APP_ENCRYPTION_KEYS: keys({ "2": K2 }), APP_ENCRYPTION_KEY_ID: "2" });
    expect([...ring.keys.keys()].sort()).toEqual(["1", "2"]);
    expect(ring.currentId).toBe("2");
  });

  it("refuses an APP_ENCRYPTION_KEY that contradicts key 1 in APP_ENCRYPTION_KEYS", () => {
    expect(() => buildKeyring({ APP_ENCRYPTION_KEY: K1, APP_ENCRYPTION_KEYS: keys({ "1": K2 }), APP_ENCRYPTION_KEY_ID: "1" })).toThrow(/differs/);
  });
});

describe("encryptWith / decryptWith", () => {
  it("round-trips, with a fresh IV each time", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEY: K1 });
    const a = encryptWith(ring, "EAAB-token");
    const b = encryptWith(ring, "EAAB-token");
    expect(a).not.toBe(b);
    expect(decryptWith(ring, a)).toBe("EAAB-token");
    expect(decryptWith(ring, b)).toBe("EAAB-token");
  });

  it("reads rows written in the old, unprefixed format using key 1", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEY: K1 });
    const old = legacyEncrypt(K1, "old-token");
    expect(keyIdOf(old)).toBe("1");
    expect(decryptWith(ring, old)).toBe("old-token");
  });

  it("keeps old values readable after the current key changes, and writes new ones with the new key", () => {
    const before = buildKeyring({ APP_ENCRYPTION_KEY: K1 });
    const stored = encryptWith(before, "page-token");
    const after = buildKeyring({ APP_ENCRYPTION_KEY: K1, APP_ENCRYPTION_KEYS: keys({ "2": K2 }), APP_ENCRYPTION_KEY_ID: "2" });
    expect(decryptWith(after, stored)).toBe("page-token");
    const migrated = encryptWith(after, decryptWith(after, stored));
    expect(keyIdOf(migrated)).toBe("2");
    // Once the old key is dropped, only migrated values still decrypt.
    const onlyNew = buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "2": K2 }), APP_ENCRYPTION_KEY_ID: "2" });
    expect(decryptWith(onlyNew, migrated)).toBe("page-token");
    expect(() => decryptWith(onlyNew, stored)).toThrow(/key "1" is not configured/);
  });

  it("rejects tampered, truncated and malformed values", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEY: K1 });
    const good = encryptWith(ring, "secret");
    const parts = good.split(".");
    const flipped = parts[3].replace(/^./, parts[3].startsWith("A") ? "B" : "A");
    expect(() => decryptWith(ring, [...parts.slice(0, 3), flipped].join("."))).toThrow();
    expect(() => decryptWith(ring, parts.slice(0, 3).join("."))).toThrow();
    expect(() => decryptWith(ring, "")).toThrow(/Invalid encrypted secret format/);
    expect(() => decryptWith(ring, "a.b.c.d.e")).toThrow(/Invalid encrypted secret format/);
  });

  it("does not decrypt with the wrong key", () => {
    const stored = encryptWith(buildKeyring({ APP_ENCRYPTION_KEY: K1 }), "secret");
    const wrong = buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "1": K2 }), APP_ENCRYPTION_KEY_ID: "1" });
    expect(() => decryptWith(wrong, stored)).toThrow();
  });
});

describe("keyIdOf", () => {
  it("reads the key version without decrypting", () => {
    const ring = buildKeyring({ APP_ENCRYPTION_KEYS: keys({ "k-2": K2 }), APP_ENCRYPTION_KEY_ID: "k-2" });
    expect(keyIdOf(encryptWith(ring, "x"))).toBe("k-2");
    expect(keyIdOf("")).toBeNull();
    expect(keyIdOf("garbage")).toBeNull();
  });
});
