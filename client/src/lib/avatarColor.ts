// Stable color assignment for user avatars. Hashes a user identifier into
// one of eight muted-neon colors so avatars without a custom icon get a
// little visual signal — same user always renders in the same color, but
// different users contrast cleanly side-by-side.
//
// Palette mirrors the chart palette in `Chart.vue` but pinned to 600-tone
// shades so white text reads cleanly on every entry. "A touch muted" per
// the ask.

export const AVATAR_PALETTE = [
  "#2563eb", // blue-600
  "#0891b2", // cyan-600
  "#059669", // emerald-600
  "#65a30d", // lime-600
  "#d97706", // amber-600
  "#db2777", // pink-600
  "#7c3aed", // violet-600
  "#dc2626", // red-600
] as const;

// FNV-1a-ish: cheap, deterministic, well-distributed for short keys like
// UUIDs. We don't need cryptographic strength — only stable bucketing
// across reloads.
function hash(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarColorFor(key: string | null | undefined): string {
  if (!key) return "#6b7280"; // gray-500 fallback for "no user"
  return AVATAR_PALETTE[hash(key) % AVATAR_PALETTE.length]!;
}
