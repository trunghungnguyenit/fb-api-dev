import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

// OAuth `state` = random nonce + HMAC bound to the signed-in user, so a state issued to one user is
// useless in another user's session (on top of the cookie match that already ties it to the browser).
function sign(userId: string, nonce: string) {
  return createHmac("sha256", env.APP_ENCRYPTION_KEY).update(`meta-oauth:${userId}:${nonce}`).digest("hex");
}

export function createOAuthState(userId: string) {
  const nonce = randomBytes(24).toString("hex");
  return `${nonce}.${sign(userId, nonce)}`;
}

export function verifyOAuthState(state: string, userId: string) {
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  const expected = Buffer.from(sign(userId, nonce));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
