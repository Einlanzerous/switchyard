import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";
import { ProjectRef } from "./project.js";
import { UserRef } from "./user.js";
import { Priority, TicketType } from "./ticket.js";

// Ticket templates (SWY-43 Phase 4.7). One template defines either a
// recurring cron schedule or a one-shot trigger date. The scheduler
// materializes a regular ticket each time the template fires.

export const OverlapPolicy = z.enum(["skip", "always", "reuse_open"]);
export type OverlapPolicy = z.infer<typeof OverlapPolicy>;

// `recurring` = cron-driven, fires repeatedly; `one_shot` = single
// trigger date, flips enabled=false after the one fire.
export const ScheduleMode = z.enum(["recurring", "one_shot"]);
export type ScheduleMode = z.infer<typeof ScheduleMode>;

export const TicketTemplate = z.object({
  id: Uuid,
  project: ProjectRef,
  enabled: z.boolean(),
  // Template fields copied into each instance.
  title: z.string().min(1).max(500),
  description: z.string(),
  type: TicketType,
  priority: Priority.nullable(),
  assignee: UserRef.nullable(),
  parent_id: Uuid.nullable(),
  label_ids: z.array(Uuid),
  metadata: z.record(z.unknown()),
  due_date_offset_days: z.number().int().nullable(),
  // Schedule — exactly one mode set. Recurring uses schedule_cron + tz;
  // one-shot uses trigger_at + lead_days. The server enforces XOR via a
  // CHECK constraint; clients see the mode reflected here.
  mode: ScheduleMode,
  schedule_cron: z.string().nullable(),
  schedule_tz: z.string().nullable(),
  trigger_at: Iso8601.nullable(),
  lead_days: z.number().int().nonnegative(),
  overlap_policy: OverlapPolicy,
  // Read-only bookkeeping.
  last_fired_at: Iso8601.nullable(),
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type TicketTemplate = z.infer<typeof TicketTemplate>;

// Create body. Exactly one of `schedule_cron` or `trigger_at` must be
// set — server returns 422 otherwise. Most fields are optional with
// sensible defaults at the DB layer.
export const CreateTicketTemplate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  type: TicketType.default("task"),
  priority: Priority.nullable().optional(),
  assignee_id: Uuid.nullable().optional(),
  parent_id: Uuid.nullable().optional(),
  label_ids: z.array(Uuid).optional(),
  metadata: z.record(z.unknown()).optional(),
  due_date_offset_days: z.number().int().nullable().optional(),
  // Recurring schedule. `schedule_cron` is a 5-field cron expression
  // (e.g. "0 9 * * MON"). `schedule_tz` is an IANA tz name; NULL = UTC.
  schedule_cron: z.string().nullable().optional(),
  schedule_tz: z.string().nullable().optional(),
  // One-shot schedule. `trigger_at` is a timestamp; the template fires
  // at `trigger_at - lead_days` (so lead_days = 7 + trigger_at = expiry
  // date materializes a "rotate before expiry" ticket a week ahead).
  trigger_at: Iso8601.nullable().optional(),
  lead_days: z.number().int().nonnegative().optional(),
  overlap_policy: OverlapPolicy.optional(),
  enabled: z.boolean().optional(),
});
export type CreateTicketTemplate = z.infer<typeof CreateTicketTemplate>;

export const UpdateTicketTemplate = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  type: TicketType.optional(),
  priority: Priority.nullable().optional(),
  assignee_id: Uuid.nullable().optional(),
  parent_id: Uuid.nullable().optional(),
  label_ids: z.array(Uuid).optional(),
  metadata: z.record(z.unknown()).optional(),
  due_date_offset_days: z.number().int().nullable().optional(),
  schedule_cron: z.string().nullable().optional(),
  schedule_tz: z.string().nullable().optional(),
  trigger_at: Iso8601.nullable().optional(),
  lead_days: z.number().int().nonnegative().optional(),
  overlap_policy: OverlapPolicy.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTicketTemplate = z.infer<typeof UpdateTicketTemplate>;
