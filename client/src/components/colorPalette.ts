// Curated swatches for the `ColorPicker` component. Every entry passes the
// luminance guard in shared/src/schemas/common.ts:HexColor, so a palette
// pick will never get rejected server-side.

// Tailwind 500-shade names — handy for human-readable color readouts.
// Order is preserved through `Object.keys(SWATCH_NAMES)`, which the picker
// renders as the grid.
export const SWATCH_NAMES = {
  "#ef4444": "red",
  "#f97316": "orange",
  "#f59e0b": "amber",
  "#eab308": "yellow",
  "#84cc16": "lime",
  "#22c55e": "green",
  "#10b981": "emerald",
  "#14b8a6": "teal",
  "#06b6d4": "cyan",
  "#0ea5e9": "sky",
  "#3b82f6": "blue",
  "#6366f1": "indigo",
  "#8b5cf6": "violet",
  "#a855f7": "purple",
  "#d946ef": "fuchsia",
  "#ec4899": "pink",
  "#f43f5e": "rose",
  "#64748b": "slate",
} as const;

export const SWATCHES = Object.keys(SWATCH_NAMES) as Array<keyof typeof SWATCH_NAMES>;
export type Swatch = (typeof SWATCHES)[number];

// Lookup the human-readable name for a hex value (case-insensitive). Returns
// undefined when the hex doesn't match a curated palette entry.
export function swatchName(hex: string): string | undefined {
  const key = hex.toLowerCase() as keyof typeof SWATCH_NAMES;
  return SWATCH_NAMES[key];
}

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
