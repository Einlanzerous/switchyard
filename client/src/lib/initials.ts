// Compute the initials shown inside an avatar.
//
// Rules:
//   - Split on whitespace OR dashes so kebab-case agent names ("n8n-vox-
//     dictate") yield meaningful two-letter initials ("NV") instead of
//     just the leading "N".
//   - Take the first letter of the first two parts, uppercased.
//   - Single-word handles ("magos", "claude") collapse to one letter —
//     the user explicitly wants those rendered as a single character.
//   - Returns "—" if there's nothing usable so the fallback never
//     renders empty space.

export function computeInitials(name: string | null | undefined): string {
  if (!name) return "—";
  const parts = name
    .split(/[\s\-]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "—";
  const out = parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return out || "—";
}

// Agent avatars render a lowercase mono handle instead of uppercase human
// initials (v4 design: squares are agents — "cl" for claude, "er" for
// external-ref-poller). Multi-part names take the first letter of the first
// two parts; single-word handles take their first two characters.
export function computeAgentInitials(name: string | null | undefined): string {
  if (!name) return "—";
  const parts = name
    .split(/[\s\-]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "—";
  const out = parts.length === 1
    ? parts[0]!.slice(0, 2)
    : parts.slice(0, 2).map((p) => p[0]!).join("");
  return out.toLowerCase() || "—";
}
