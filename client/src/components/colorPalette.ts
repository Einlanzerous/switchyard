// Curated swatches for the `ColorPicker` component. Every entry passes the
// luminance guard in shared/src/schemas/common.ts:HexColor, so a palette
// pick will never get rejected server-side.

export const SWATCHES = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#f43f5e", "#64748b",
] as const;

export type Swatch = (typeof SWATCHES)[number];

// Pick the first palette swatch not present in `used`. Falls back to a
// deterministic key-derived index if every palette entry is taken, so the
// default stays stable across reloads even in the unlikely full case.
export function pickUnusedSwatch(
  used: Iterable<string | null | undefined>,
  fallbackKey = "",
): string {
  const taken = new Set(
    Array.from(used)
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.toLowerCase()),
  );
  for (const s of SWATCHES) {
    if (!taken.has(s.toLowerCase())) return s;
  }
  let hash = 0;
  for (let i = 0; i < fallbackKey.length; i++) {
    hash = (hash * 31 + fallbackKey.charCodeAt(i)) >>> 0;
  }
  return SWATCHES[hash % SWATCHES.length]!;
}
