import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";

// Maximum observations per bulk POST. Tuned for typical n8n end-of-workflow
// flushes (10–50 calls) with generous headroom; hard 422 if exceeded so
// emitters can't unintentionally DOS the endpoint by mis-batching.
export const LLM_OBSERVATIONS_MAX_BATCH = 500;

// Free-form short strings on the dimension columns. Validation is "is it a
// short non-empty string" — the values themselves are warn-listed at the
// route layer (unknown values capture to llm_obs_pending_values for admin
// review rather than 422'ing the write).
const ShortString = z.string().min(1).max(128);

export const LlmObservationInput = z.object({
  occurred_at: Iso8601,
  // Optional. When set, resolved to a ticket UUID server-side via the same
  // key/UUID resolver the ticket endpoints use. Null for ambient ops
  // (Scribe routing decisions happen before a ticket exists).
  ticket_key: z.string().min(1).max(64).optional(),
  service: ShortString,
  operation: ShortString,
  model: ShortString,
  provider: ShortString,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative(),
  error_code: z.string().min(1).max(64).optional(),
  // Per-observation natural key for at-most-once writes. Strongly recommended
  // for emitters that retry batches. Server applies INSERT ... ON CONFLICT
  // (dedup_key) DO NOTHING.
  dedup_key: z.string().min(1).max(256).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type LlmObservationInput = z.infer<typeof LlmObservationInput>;

export const LlmObservationBatchRequest = z.object({
  observations: z.array(LlmObservationInput).min(1).max(LLM_OBSERVATIONS_MAX_BATCH),
});
export type LlmObservationBatchRequest = z.infer<typeof LlmObservationBatchRequest>;

export const PendingValueCaptured = z.object({
  dimension: z.enum(["service", "operation", "model", "provider"]),
  value: z.string(),
});
export type PendingValueCaptured = z.infer<typeof PendingValueCaptured>;

export const LlmObservationBatchResponse = z.object({
  accepted: z.number().int().nonnegative(),
  // dedup_key matched an existing row — ON CONFLICT DO NOTHING fired.
  deduplicated: z.number().int().nonnegative(),
  // New dimension values surfaced for admin review. Deduplicated across
  // the batch so the same unknown value reported by 50 calls only appears
  // once in the response.
  pending_captured: z.array(PendingValueCaptured),
});
export type LlmObservationBatchResponse = z.infer<typeof LlmObservationBatchResponse>;

// Full row shape — useful for the future Insights → LLM tab API surface.
// Not used by the POST endpoint (which only returns the batch summary).
export const LlmObservation = z.object({
  id: Uuid,
  occurred_at: Iso8601,
  actor_id: Uuid,
  ticket_id: Uuid.nullable(),
  service: z.string(),
  operation: z.string(),
  model: z.string(),
  provider: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int().nullable(),
  cache_read_input_tokens: z.number().int().nullable(),
  latency_ms: z.number().int(),
  error_code: z.string().nullable(),
  dedup_key: z.string().nullable(),
  metadata: z.record(z.unknown()),
  created_at: Iso8601,
});
export type LlmObservation = z.infer<typeof LlmObservation>;
