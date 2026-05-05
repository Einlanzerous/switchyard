import { describe, expect, test } from "bun:test";
import { signHmac, verifyHmac } from "../../src/lib/hmac.js";

describe("hmac signing", () => {
  test("sign produces a 64-char lowercase hex string", () => {
    const sig = signHmac("secret-key", "the body");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input => same signature", () => {
    expect(signHmac("k", "b")).toBe(signHmac("k", "b"));
  });

  test("different secret => different signature", () => {
    expect(signHmac("k1", "b")).not.toBe(signHmac("k2", "b"));
  });

  test("different body => different signature", () => {
    expect(signHmac("k", "b1")).not.toBe(signHmac("k", "b2"));
  });
});

describe("hmac verification", () => {
  test("valid signature verifies", () => {
    const body = JSON.stringify({ id: "evt_1", event: "ticket.created" });
    const sig = signHmac("topsecret", body);
    expect(verifyHmac("topsecret", body, sig)).toBe(true);
  });

  test("accepts sha256= prefix", () => {
    const body = "x";
    const sig = signHmac("k", body);
    expect(verifyHmac("k", body, `sha256=${sig}`)).toBe(true);
  });

  test("rejects tampered body", () => {
    const sig = signHmac("k", "original");
    expect(verifyHmac("k", "tampered", sig)).toBe(false);
  });

  test("rejects wrong secret", () => {
    const sig = signHmac("right", "x");
    expect(verifyHmac("wrong", "x", sig)).toBe(false);
  });

  test("rejects malformed signature", () => {
    expect(verifyHmac("k", "x", "not-hex")).toBe(false);
    expect(verifyHmac("k", "x", "sha256=abc")).toBe(false);
  });
});
