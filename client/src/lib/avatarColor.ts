// Stable color assignment for HUMAN user avatars. Hashes a user identifier
// into one of eight warm muted colors so avatars without a custom icon get a
// little visual signal — same user always renders in the same color, but
// different users contrast cleanly side-by-side.
//
// v4 "Elevated" family: earthy, desaturated hues at similar lightness so
// they sit on the dark ink without neon pop. Agents never come through
// here — they render in the steel `--agent` tint (see UserAvatar).

const AVATAR_PALETTE = [
  "#c65a4a", // terracotta (the design's human example hue)
  "#bd7f45", // clay amber
  "#a8934c", // olive gold
  "#7ba05f", // moss
  "#55a08b", // sea green
  "#5f8fb4", // dusty blue
  "#8d7bc0", // lavender
  "#b56d94", // rose mauve
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
  if (!key) return "#4d4e54"; // ink-4 ghost for "no user"
  return AVATAR_PALETTE[hash(key) % AVATAR_PALETTE.length]!;
}
