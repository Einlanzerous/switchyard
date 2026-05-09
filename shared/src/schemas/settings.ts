import { z } from "zod";
import { Iso8601 } from "./common.js";

// system_settings is a key/value store used for runtime-tunable globals
// (currently just `stale_in_progress_days`). Keys are typed via this union
// so adding one is a deliberate code change rather than a free-form admin
// edit. The value shape is constrained per-key.

export const SystemSettingKey = z.enum([
  "stale_in_progress_days",
]);
export type SystemSettingKey = z.infer<typeof SystemSettingKey>;

export const SystemSettings = z.object({
  // Threshold (days) used by /v1/projects/:key/stats to count tickets that
  // have been in_progress longer than this as "stale". Default 30 — set for
  // personal use; companies tracking SLAs would lower it.
  stale_in_progress_days: z.number().int().min(1).max(3650),
  updated_at: Iso8601,
});
export type SystemSettings = z.infer<typeof SystemSettings>;

// PATCH body — every field optional, validated against the same constraints.
// We don't allow setting `updated_at`; the server stamps it.
export const UpdateSystemSettings = z
  .object({
    stale_in_progress_days: z.number().int().min(1).max(3650).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "at least one field required");
export type UpdateSystemSettings = z.infer<typeof UpdateSystemSettings>;

export const DEFAULT_STALE_IN_PROGRESS_DAYS = 30;
