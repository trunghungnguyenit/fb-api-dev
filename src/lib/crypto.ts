import { env } from "@/lib/env";
import { buildKeyring, decryptWith, encryptWith } from "@/lib/crypto-core";

const keyring = buildKeyring(env);

export function encryptSecret(value: string): string {
  return encryptWith(keyring, value);
}

export function decryptSecret(payload: string): string {
  return decryptWith(keyring, payload);
}

/** Keys for HMAC-signing short-lived values: sign with `current`, accept a signature from any configured key. */
export const signingKeys = { current: keyring.keys.get(keyring.currentId)!, all: [...keyring.keys.values()] };
