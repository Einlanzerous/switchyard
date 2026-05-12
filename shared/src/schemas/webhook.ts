import { z } from "zod";
import { Uuid, Iso8601, Timestamps } from "./common.js";
import { EventType, Event } from "./event.js";
import { StatusCategory } from "./status.js";

// Optional secondary filter — only fire if the event matches all listed conditions.
// Empty/undefined = no extra filtering.
export const WebhookStatusFilter = z
  .object({
    to_category: StatusCategory.optional(),
    from_category: StatusCategory.optional(),
    to_status_display_name: z.string().optional(),
  })
  .partial();
export type WebhookStatusFilter = z.infer<typeof WebhookStatusFilter>;

export const WebhookSubscription = z
  .object({
    id: Uuid,
    url: z.string().url(),
    event_types: z.array(z.union([EventType, z.literal("*")])).min(1),
    status_filter: WebhookStatusFilter.nullable(),
    // Phase 4.2.5: optional named target. When set, the dispatcher
    // resolves the URL + signing secret from the target at delivery
    // time; the literal `url` + `secret` remain as fallback if the
    // target is deleted (FK is ON DELETE SET NULL).
    target_id: Uuid.nullable(),
    active: z.boolean(),
    // Secret is omitted from responses after creation; only returned once on POST.
  })
  .merge(Timestamps);
export type WebhookSubscription = z.infer<typeof WebhookSubscription>;

export const CreateWebhookSubscription = z.object({
  url: z.string().url(),
  event_types: z.array(z.union([EventType, z.literal("*")])).min(1),
  status_filter: WebhookStatusFilter.optional(),
  // Optional target reference; subscriptions can stick with the literal
  // URL form or attach to a named target.
  target_id: Uuid.optional(),
  active: z.boolean().default(true),
});
export type CreateWebhookSubscription = z.infer<typeof CreateWebhookSubscription>;

export const UpdateWebhookSubscription = CreateWebhookSubscription.partial().extend({
  // Allow explicit null on PATCH to detach a target without recreating
  // the subscription. `.partial()` makes target_id optional already;
  // we widen it here so callers can clear it.
  target_id: Uuid.nullable().optional(),
});
export type UpdateWebhookSubscription = z.infer<typeof UpdateWebhookSubscription>;

export const WebhookSubscriptionWithSecret = WebhookSubscription.extend({
  secret: z.string(),
});
export type WebhookSubscriptionWithSecret = z.infer<typeof WebhookSubscriptionWithSecret>;

// Outbound webhook envelope — wire format n8n receives.
// Identical to the Event schema but explicit so the contract is documented.
export const WebhookPayload = Event;
export type WebhookPayload = z.infer<typeof WebhookPayload>;

// Delivery attempt log — visible via API for debugging.
export const WebhookDeliveryStatus = z.enum([
  "pending",
  "delivering",
  "succeeded",
  "failed",
  "abandoned",
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookDelivery = z.object({
  id: Uuid,
  subscription_id: Uuid,
  event_id: Uuid,
  status: WebhookDeliveryStatus,
  response_code: z.number().int().nullable(),
  response_body_excerpt: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_attempt_at: Iso8601.nullable(),
  next_attempt_at: Iso8601.nullable(),
  created_at: Iso8601,
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;
