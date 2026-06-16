import { z } from "zod";
import { Iso8601 } from "./common.js";

// system_settings is a key/value store used for runtime-tunable globals
// (currently just `stale_in_progress_days`). Keys are typed via this union
// so adding one is a deliberate code change rather than a free-form admin
// edit. The value shape is constrained per-key.

export const SystemSettingKey = z.enum([
  "stale_in_progress_days",
  "board_closed_window_days",
  "llm_obs_usd_per_kwh",
  "llm_obs_retention_days",
  "hitl_stall_in_progress_hours",
  "hitl_stall_silent_hours",
]);
export type SystemSettingKey = z.infer<typeof SystemSettingKey>;

// How long ago a closed ticket can have been touched and still appear in
// a kanban board's Closed column. Constrained to a small enum so the UI
// can render a clean toggle and so the per-project override can validate
// the same way. No "show all" — unbounded Closed columns are a footgun.
export const ClosedWindowDays = z.union([
  z.literal(7), z.literal(14), z.literal(30),
]);
export type ClosedWindowDays = z.infer<typeof ClosedWindowDays>;

export const SystemSettings = z.object({
  // Threshold (days) used by /v1/projects/:key/stats to count tickets that
  // have been in_progress longer than this as "stale". Default 30 — set for
  // personal use; companies tracking SLAs would lower it.
  stale_in_progress_days: z.number().int().min(1).max(3650),
  // Default window for the Closed column on kanban boards. Per-project
  // override lives on the project row; null there = inherit this value.
  board_closed_window_days: ClosedWindowDays,
  // Electricity rate (USD per kWh) used to cost local/energy-priced LLM calls
  // in the llm_observations_with_cost view. Default 0.17 (Chicago). SWY-48.
  llm_obs_usd_per_kwh: z.number().min(0).max(10),
  // How long raw llm_observations rows are retained before the cleanup job
  // deletes them. Daily rollups are kept forever. Default 180. SWY-48.
  llm_obs_retention_days: z.number().int().min(1).max(3650),
  // HITL stall detector (Insights → LLM): a ticket in_progress longer than
  // this many hours with no LLM activity in the last `silent_hours` is flagged.
  hitl_stall_in_progress_hours: z.number().min(1).max(8760),
  hitl_stall_silent_hours: z.number().min(1).max(8760),
  updated_at: Iso8601,
});
export type SystemSettings = z.infer<typeof SystemSettings>;

// PATCH body — every field optional, validated against the same constraints.
// We don't allow setting `updated_at`; the server stamps it.
export const UpdateSystemSettings = z
  .object({
    stale_in_progress_days: z.number().int().min(1).max(3650).optional(),
    board_closed_window_days: ClosedWindowDays.optional(),
    llm_obs_usd_per_kwh: z.number().min(0).max(10).optional(),
    llm_obs_retention_days: z.number().int().min(1).max(3650).optional(),
    hitl_stall_in_progress_hours: z.number().min(1).max(8760).optional(),
    hitl_stall_silent_hours: z.number().min(1).max(8760).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "at least one field required");
export type UpdateSystemSettings = z.infer<typeof UpdateSystemSettings>;

export const DEFAULT_STALE_IN_PROGRESS_DAYS = 30;
export const DEFAULT_BOARD_CLOSED_WINDOW_DAYS: ClosedWindowDays = 14;
// Chicago residential rate mid-2026; tune in Settings as the grid rate drifts.
export const DEFAULT_LLM_OBS_USD_PER_KWH = 0.17;
// Half a year of raw observations covers the realistic investigation window.
export const DEFAULT_LLM_OBS_RETENTION_DAYS = 180;
// A ticket in_progress > 1 day with no model call in the last 4h likely stalled
// on a human (HITL) — defaults tuned for the imperium-loop cadence.
export const DEFAULT_HITL_STALL_IN_PROGRESS_HOURS = 24;
export const DEFAULT_HITL_STALL_SILENT_HOURS = 4;
