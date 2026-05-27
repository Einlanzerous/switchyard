// Single source of truth for status-category colors. Display names can be
// aliased per-project but the color always tracks the underlying category,
// so the meaning stays stable across the app (badges, donut slices, board
// chrome, etc.).
//
// - `STATUS_BADGE_TONE` is the Tailwind class string used by `StatusBadge`
//   and anywhere else that wants a bg/text/border tint trio.
// - `STATUS_HEX` is the raw hex color used by ECharts, which wants strings
//   on `itemStyle.color`, not Tailwind classes.

import type { StatusCategory } from "@switchyard/shared";

export const STATUS_BADGE_TONE: Record<StatusCategory, string> = {
  backlog:
    "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30",
  planning:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  in_progress:
    "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
  blocked:
    "bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/30",
  closed:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
};

// Tailwind 500-shade hex values, kept in sync with STATUS_BADGE_TONE above.
export const STATUS_HEX: Record<StatusCategory, string> = {
  backlog: "#8b5cf6",
  planning: "#f59e0b",
  in_progress: "#3b82f6",
  blocked: "#ef4444",
  closed: "#10b981",
};
