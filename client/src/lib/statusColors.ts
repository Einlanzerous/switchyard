// Single source of truth for status-category colors. Display names can be
// aliased per-project but the color always tracks the underlying category,
// so the meaning stays stable across the app (badges, donut slices, board
// chrome, etc.).
//
// - `STATUS_BADGE_TONE` is the Tailwind class string used by `StatusBadge`
//   and anywhere else that wants a bg/text tint pair.
// - `STATUS_HEX` is the raw color string used by ECharts (which wants
//   strings on `itemStyle.color`, not Tailwind classes) and inline styles.
//
// v4 "Elevated" family (SWY-133): one tuned palette — consistent lightness/
// chroma so the five categories read as a family.
//
// Theme-aware since SWY-158: the `--st-*` CSS vars flip between light and
// dark (style.css), so this module reads them from the live document instead
// of hardcoding. `STATUS_HEX` is a reactive record refreshed on every
// html.class flip — templates and chart-option computeds that index into it
// re-evaluate on theme toggle with no per-consumer wiring. Values are
// `rgb(r,g,b)` strings (the vars hold channel triplets); ECharts and inline
// styles both accept them anywhere a hex would go.

import { reactive, ref } from "vue";
import type { StatusCategory } from "@switchyard/shared";

export const STATUS_BADGE_TONE: Record<StatusCategory, string> = {
  backlog: "bg-st-backlog-bg text-st-backlog border-st-backlog/30",
  planning: "bg-st-planning-bg text-st-planning border-st-planning/30",
  in_progress: "bg-st-progress-bg text-st-progress border-st-progress/30",
  blocked: "bg-st-blocked-bg text-st-blocked border-st-blocked/30",
  closed: "bg-st-closed-bg text-st-closed border-st-closed/30",
};

const ST_VAR: Record<StatusCategory, string> = {
  backlog: "--st-backlog",
  planning: "--st-planning",
  in_progress: "--st-progress",
  blocked: "--st-blocked",
  closed: "--st-closed",
};

// Dark design constants — fallback when the vars aren't readable (unit
// tests, module init before stylesheet application).
const ST_FALLBACK: Record<StatusCategory, string> = {
  backlog: "#808289",
  planning: "#c08cd8",
  in_progress: "#64a0d6",
  blocked: "#d76f6a",
  closed: "#63b58c",
};

// Bumped on every html.class change so `cssVarRgb` calls inside computeds
// re-evaluate on theme flip (same MutationObserver pattern as Chart.vue,
// hoisted here so every consumer shares one observer).
const themeRev = ref(0);

/**
 * Read a v4 `R G B` channel-triplet CSS variable (see style.css) from the
 * live document and return comma-form `rgb(r,g,b)` — ECharts' color parser
 * doesn't understand the space-separated syntax. Reactive: callers inside
 * computeds/templates re-run when the theme class flips.
 */
export function cssVarRgb(name: string, fallback: string): string {
  void themeRev.value;
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.split(/\s+/).join(",")})` : fallback;
}

export const STATUS_HEX: Record<StatusCategory, string> = reactive({ ...ST_FALLBACK });

function refresh() {
  for (const cat of Object.keys(ST_VAR) as StatusCategory[]) {
    STATUS_HEX[cat] = cssVarRgb(ST_VAR[cat], ST_FALLBACK[cat]);
  }
}

if (typeof window !== "undefined") {
  new MutationObserver(() => {
    themeRev.value++;
    refresh();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  refresh();
}
