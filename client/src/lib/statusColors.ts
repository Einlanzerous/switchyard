// Single source of truth for status-category colors. Display names can be
// aliased per-project but the color always tracks the underlying category,
// so the meaning stays stable across the app (badges, donut slices, board
// chrome, etc.).
//
// - `STATUS_BADGE_TONE` is the Tailwind class string used by `StatusBadge`
//   and anywhere else that wants a bg/text tint pair.
// - `STATUS_HEX` is the raw hex color used by ECharts, which wants strings
//   on `itemStyle.color`, not Tailwind classes.
//
// v4 "Elevated" family (SWY-133): one tuned palette — consistent lightness/
// chroma so the five categories read as a family. Tailwind `st-*` utilities
// and the `--st-*` CSS vars carry the same values.

import type { StatusCategory } from "@switchyard/shared";

export const STATUS_BADGE_TONE: Record<StatusCategory, string> = {
  backlog: "bg-st-backlog-bg text-st-backlog border-st-backlog/30",
  planning: "bg-st-planning-bg text-st-planning border-st-planning/30",
  in_progress: "bg-st-progress-bg text-st-progress border-st-progress/30",
  blocked: "bg-st-blocked-bg text-st-blocked border-st-blocked/30",
  closed: "bg-st-closed-bg text-st-closed border-st-closed/30",
};

// Kept in sync with STATUS_BADGE_TONE above (and tailwind.config.ts `st`).
export const STATUS_HEX: Record<StatusCategory, string> = {
  backlog: "#808289",
  planning: "#c08cd8",
  in_progress: "#64a0d6",
  blocked: "#d76f6a",
  closed: "#63b58c",
};
