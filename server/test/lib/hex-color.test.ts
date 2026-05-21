// Contrast guard on HexColor. Catches values that would disappear against
// the light or dark theme backgrounds. See shared/src/schemas/common.ts.

import { describe, expect, test } from "bun:test";
import {
  HexColor,
  isContrastSafe,
  LUMINANCE_LOWER,
  LUMINANCE_UPPER,
} from "../../../shared/src/schemas/common.ts";

describe("HexColor luminance guard", () => {
  test("rejects pure white and near-white", () => {
    expect(HexColor.safeParse("#ffffff").success).toBe(false);
    expect(HexColor.safeParse("#f8fafc").success).toBe(false);
  });

  test("rejects pure black and near-black", () => {
    expect(HexColor.safeParse("#000000").success).toBe(false);
    expect(HexColor.safeParse("#020617").success).toBe(false);
  });

  test("accepts the existing palette (Tailwind 500/600 shades)", () => {
    const swatches = [
      "#ef4444", "#f97316", "#f59e0b", "#eab308",
      "#84cc16", "#22c55e", "#10b981", "#14b8a6",
      "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
      "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
      "#f43f5e", "#64748b",
    ];
    for (const s of swatches) {
      expect(HexColor.safeParse(s).success).toBe(true);
    }
  });

  test("rejects malformed hex shape (regression check)", () => {
    expect(HexColor.safeParse("not-a-hex").success).toBe(false);
    expect(HexColor.safeParse("#fff").success).toBe(false);
    expect(HexColor.safeParse("#gggggg").success).toBe(false);
  });

  test("isContrastSafe directly mirrors the schema verdict", () => {
    expect(isContrastSafe("#3b82f6")).toBe(true);
    expect(isContrastSafe("#ffffff")).toBe(false);
    expect(LUMINANCE_LOWER).toBeLessThan(LUMINANCE_UPPER);
  });
});
