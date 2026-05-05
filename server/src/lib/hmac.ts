import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-SHA256 of `body` with `secret`, returned as lowercase hex.
// We send this as `X-Switchyard-Signature: sha256=<hex>` on every webhook POST.
export function signHmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Constant-time comparison of two hex signatures. Used by clients verifying
// inbound webhooks; exposed here so tests can reuse the same logic.
export function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = signHmac(secret, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
