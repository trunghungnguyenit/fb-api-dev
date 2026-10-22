import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { signingKeys } from "@/lib/crypto";

// OAuth `state` = random nonce + HMAC bound to the signed-in user, so a state issued to one user is
// useless in another user's session (on top of the cookie match that already ties it to the browser).
function sign(key: Buffer, userId: string, nonce: string) {
  return createHmac("sha256", key).update(`meta-oauth:${userId}:${nonce}`).digest("hex");
}

export function createOAuthState(userId: string) {
  const nonce = randomBytes(24).toString("hex");
  return `${nonce}.${sign(signingKeys.current, userId, nonce)}`;
}

export function verifyOAuthState(state: string, userId: string) {
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  const actual = Buffer.from(signature);
  // Any configured key counts, so a state issued just before the current key was switched still verifies.
  return signingKeys.all.some((key) => {
    const expected = Buffer.from(sign(key, userId, nonce));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}
