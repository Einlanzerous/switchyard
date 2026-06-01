/**
 * Deterministic hue (0-359) from a stable id, so the same entity always renders
 * the same color without a stored color column. Used by EpicChip (SWY-83).
 */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
