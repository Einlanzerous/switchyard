import { randomBytes, createHash } from "node:crypto";

const TOKEN_PREFIX = "sw_";
const TOKEN_BYTES = 24; // 24 bytes -> 39 base32 chars; we trim to 32

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(TOKEN_BYTES);
  const body = base32Encode(raw).slice(0, 32);
  const token = `${TOKEN_PREFIX}${body}`;
  const hash = createHash("sha256").update(token).digest("hex");
  // First 7 chars of the body for log identification: "sw_ABCDEFG"
  const prefix = `${TOKEN_PREFIX}${body.slice(0, 7)}`;
  return { token, hash, prefix };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateWebhookSecret(): string {
  return base32Encode(randomBytes(24)).slice(0, 32);
}
