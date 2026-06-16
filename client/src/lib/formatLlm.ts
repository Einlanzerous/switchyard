// Formatting helpers for the LLM Insights tiles (SWY-48 / 5.1.2).

// USD with precision that scales to the magnitude — local energy costs are
// fractions of a cent, API costs are dollars.
export function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}

// Compact token / call counts: 1234 → "1.2k", 3_400_000 → "3.4M".
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  return compact.format(n);
}

// Latency in ms → "320ms" / "4.3s".
export function formatLatencyMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// A percentage already in 0–100 → "4.2%". null → "—".
export function formatPct(pct: number | null | undefined, digits = 1): string {
  if (pct == null) return "—";
  return `${pct.toFixed(digits)}%`;
}

// Rough "in progress for" / "since" label from a fractional hours value.
export function formatHours(h: number | null | undefined): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
