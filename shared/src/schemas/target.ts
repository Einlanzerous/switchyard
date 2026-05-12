import { z } from "zod";
import { Uuid, Timestamps } from "./common.js";

// Phase 4.2.5 — named webhook targets. Decouples webhook URLs from the
// rules/subscriptions that point at them so swapping a service's host
// is one PATCH instead of N edits.

// URL-safe slug: alphanumeric + dash + underscore. The server lowercases
// at write time so "n8n" and "N8N" collapse to one row.
export const TargetName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "name must be alphanumeric, '-', or '_'");

export const Target = z
  .object({
    id: Uuid,
    name: TargetName,
    description: z.string().nullable(),
    url: z.string().url(),
    headers: z.record(z.string()).nullable(),
    // hmac_secret is omitted from responses after creation; only the POST
    // response includes it (returned via TargetWithSecret).
  })
  .merge(Timestamps);
export type Target = z.infer<typeof Target>;

export const TargetWithSecret = Target.extend({
  // Always present on POST. NULL when the operator explicitly disabled
  // signing for this target (e.g. an internal endpoint that doesn't
  // verify); in that case fire_webhook falls back to the rule's
  // webhook_secret.
  hmac_secret: z.string().nullable(),
});
export type TargetWithSecret = z.infer<typeof TargetWithSecret>;

export const CreateTarget = z.object({
  name: TargetName,
  description: z.string().max(1000).optional(),
  url: z.string().url(),
  // If omitted on POST the server generates one. Pass null to skip
  // HMAC signing entirely for this target.
  hmac_secret: z.string().min(16).nullable().optional(),
  headers: z.record(z.string()).optional(),
});
export type CreateTarget = z.infer<typeof CreateTarget>;

export const UpdateTarget = z.object({
  // Name changes are allowed but discouraged — anything referencing the
  // target by name in action JSONB breaks. UI should warn.
  name: TargetName.optional(),
  description: z.string().max(1000).nullable().optional(),
  url: z.string().url().optional(),
  hmac_secret: z.string().min(16).nullable().optional(),
  headers: z.record(z.string()).nullable().optional(),
});
export type UpdateTarget = z.infer<typeof UpdateTarget>;

// DELETE /v1/targets/{id} returns the generic conflict envelope with
// details.subscription_ids + details.rule_ids when the target is still
// referenced. UI inspects those arrays to prompt for explicit detach.
