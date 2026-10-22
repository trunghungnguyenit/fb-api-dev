import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Pure AES-256-GCM helpers over a versioned keyring. No imports from the app (no "@/" alias, no env), so the
// re-encrypt script (scripts/reencrypt-secrets.ts, run by Node directly) and the app share exactly this code.
//
// Ciphertext format: `v<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). Older rows have no prefix
// (`<iv>.<tag>.<ciphertext>`): they were written before key versions existed and belong to key LEGACY_KEY_ID.

export const LEGACY_KEY_ID = "1";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_KEY_PATTERN = /^[a-fA-F0-9]{64}$/;

export type KeyringConfig = {
  /** Single-key setup (the original configuration). Counts as key "1" when `APP_ENCRYPTION_KEYS` has no "1". */
  APP_ENCRYPTION_KEY?: string;
  /** JSON object `{ "<id>": "<64 hex chars>" }` with every key that may still be needed to decrypt. */
  APP_ENCRYPTION_KEYS?: string;
  /** Id of the key used to encrypt NEW values. Required when `APP_ENCRYPTION_KEYS` is set. */
  APP_ENCRYPTION_KEY_ID?: string;
};

export type Keyring = { currentId: string; keys: ReadonlyMap<string, Buffer> };

function toKey(id: string, hex: unknown) {
  if (!KEY_ID_PATTERN.test(id)) throw new Error(`Invalid encryption key id "${id}": use 1-32 letters, digits, "_" or "-"`);
  if (typeof hex !== "string" || !HEX_KEY_PATTERN.test(hex.trim())) throw new Error(`Encryption key "${id}" must be 32 bytes in hex (64 hex characters)`);
  return Buffer.from(hex.trim(), "hex");
}

/** Builds the keyring from configuration. Throws a descriptive error (never containing key material). */
export function buildKeyring(config: KeyringConfig): Keyring {
  const keys = new Map<string, Buffer>();

  const rawKeys = config.APP_ENCRYPTION_KEYS?.trim();
  if (rawKeys) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawKeys); }
    catch { throw new Error('APP_ENCRYPTION_KEYS must be JSON like {"1":"<64 hex>","2":"<64 hex>"}'); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error('APP_ENCRYPTION_KEYS must be a JSON object like {"1":"<64 hex>","2":"<64 hex>"}');
    }
    for (const [id, hex] of Object.entries(parsed)) keys.set(id, toKey(id, hex));
  }

  // The original single-key variable stays valid so existing deployments keep working, and keeps decrypting
  // rows written before versioning while a new key becomes current.
  const legacy = config.APP_ENCRYPTION_KEY?.trim();
  if (legacy) {
    const legacyKey = toKey(LEGACY_KEY_ID, legacy);
    const existing = keys.get(LEGACY_KEY_ID);
    if (!existing) keys.set(LEGACY_KEY_ID, legacyKey);
    else if (!existing.equals(legacyKey)) {
      throw new Error(`APP_ENCRYPTION_KEY differs from key "${LEGACY_KEY_ID}" in APP_ENCRYPTION_KEYS: remove one of them`);
    }
  }
  if (!keys.size) throw new Error("Set APP_ENCRYPTION_KEY (single key) or APP_ENCRYPTION_KEYS (versioned keys)");

  const currentId = config.APP_ENCRYPTION_KEY_ID?.trim() || (rawKeys ? "" : LEGACY_KEY_ID);
  if (!currentId) throw new Error("APP_ENCRYPTION_KEY_ID is required when APP_ENCRYPTION_KEYS is set");
  if (!keys.has(currentId)) throw new Error(`APP_ENCRYPTION_KEY_ID "${currentId}" is not one of the configured keys`);
  return { currentId, keys };
}

export function encryptWith(ring: Keyring, value: string): string {
  const key = ring.keys.get(ring.currentId);
  if (!key) throw new Error(`Encryption key "${ring.currentId}" is not configured`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [`v${ring.currentId}`, ...[iv, tag, ciphertext].map((part) => part.toString("base64url"))].join(".");
}

type ParsedPayload = { keyId: string; iv: string; tag: string; ciphertext: string };

function parsePayload(payload: string): ParsedPayload | null {
  const parts = payload.split(".");
  if (parts.length === 3 && parts.every(Boolean)) {
    return { keyId: LEGACY_KEY_ID, iv: parts[0], tag: parts[1], ciphertext: parts[2] };
  }
  if (parts.length === 4 && parts.every(Boolean) && parts[0].startsWith("v") && KEY_ID_PATTERN.test(parts[0].slice(1))) {
    return { keyId: parts[0].slice(1), iv: parts[1], tag: parts[2], ciphertext: parts[3] };
  }
  return null;
}

/** Which key a stored value was encrypted with, read from its format only (no decryption). null = not a ciphertext. */
export function keyIdOf(payload: string): string | null {
  return parsePayload(payload)?.keyId ?? null;
}

export function decryptWith(ring: Keyring, payload: string): string {
  const parsed = parsePayload(payload);
  if (!parsed) throw new Error("Invalid encrypted secret format");
  const key = ring.keys.get(parsed.keyId);
  if (!key) throw new Error(`Encryption key "${parsed.keyId}" is not configured`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
