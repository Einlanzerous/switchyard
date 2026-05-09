// Format a millisecond duration as a short human string ("3d 4h", "12m",
// "<1m"). Used in KPI cards and cycle-time displays. Two units max so the
// result fits in a small card without wrapping.

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ms < minute) return "<1m";

  const parts: string[] = [];
  let rem = ms;

  if (rem >= day) {
    const d = Math.floor(rem / day);
    parts.push(`${d}d`);
    rem -= d * day;
  }
  if (rem >= hour && parts.length < 2) {
    const h = Math.floor(rem / hour);
    if (h > 0) parts.push(`${h}h`);
    rem -= h * hour;
  }
  if (parts.length === 0 && rem >= minute) {
    parts.push(`${Math.floor(rem / minute)}m`);
  }
  return parts.length > 0 ? parts.join(" ") : "<1m";
}

export function formatDeltaPercent(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;  // can't compute meaningful % from 0
  const delta = ((now - prev) / prev) * 100;
  return Math.round(delta);
}
