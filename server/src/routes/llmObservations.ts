// POST /v1/llm-observations — bulk endpoint for per-call LLM observations
// emitted by every pipeline service (n8n-cogitation, servo-signal,
// autosavant-bot, etc.). Phase 5.1.0 (SWY-48) ships the write path only;
// the read-side dashboards land in 5.1.2.
//
// Dedup strategy (two-layer):
//   - HTTP Idempotency-Key header — request-level response caching (24h).
//   - Per-observation `dedup_key` field with a partial unique index —
//     `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` lets emitters retry
//     a partially-applied batch safely. New observations land, already-
//     written ones skip silently.
//
// Cardinality strategy: warn-list, not allow-list. Unknown values for
// service/operation/model/provider land successfully and accumulate in
// `llm_obs_pending_values` for admin review (5.1.2). Avoids the "pipeline
// silently 422-ing because a model name shifted" failure mode.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  LlmObservationBatchRequest,
  LlmObservationBatchResponse,
  LLM_OBSERVATIONS_MAX_BATCH,
  LlmPendingValueList, LlmPendingValue, LlmPendingValueQuery,
  type LlmObservationInput,
  type PendingValueCaptured,
  type LlmPendingResolution,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, checkScope, idempotencyHeader, z } from "./_helpers.js";
import { resolveTicket } from "../lib/lookups.js";
import { unprocessable, notFound } from "../errors.js";
import { assertInstanceAdmin } from "../lib/authz.js";

const tag = "LLM Observations";

const create = createRoute({
  method: "post",
  path: "/v1/llm-observations",
  tags: [tag],
  summary: "Bulk-write LLM per-call observations",
  description:
    `Accept up to ${LLM_OBSERVATIONS_MAX_BATCH} observations per request. ` +
    "Each observation may carry a `dedup_key` for at-most-once writes via " +
    "`INSERT ... ON CONFLICT DO NOTHING` — safe to retry a partially-applied " +
    "batch. Unknown service/operation/model/provider values land successfully " +
    "and surface in the response's `pending_captured` for admin review.",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: LlmObservationBatchRequest } } },
  },
  responses: { ...okJson(LlmObservationBatchResponse), ...errorResponses },
});

const DIMENSIONS = ["service", "operation", "model", "provider"] as const;
type Dimension = (typeof DIMENSIONS)[number];

// ── warn-list admin (Admin → Observability) ──────────────────────────────────

const adminTag = "LLM Observations (admin)";

const listPending = createRoute({
  method: "get",
  path: "/v1/admin/llm-obs/pending-values",
  tags: [adminTag],
  summary: "List unknown dimension values pending review",
  request: { query: LlmPendingValueQuery },
  responses: { ...okJson(LlmPendingValueList), ...errorResponses },
});

const promotePending = createRoute({
  method: "post",
  path: "/v1/admin/llm-obs/pending-values/{id}/promote",
  tags: [adminTag],
  summary: "Mark a pending dimension value as known (resolve)",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...okJson(LlmPendingValue), ...errorResponses },
});

const rejectPending = createRoute({
  method: "post",
  path: "/v1/admin/llm-obs/pending-values/{id}/reject",
  tags: [adminTag],
  summary: "Reject a pending dimension value (resolve)",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { ...okJson(LlmPendingValue), ...errorResponses },
});

function mapPending(r: typeof schema.llmObsPendingValues.$inferSelect): LlmPendingValue {
  return {
    id: r.id,
    dimension: r.dimension as LlmPendingValue["dimension"],
    value: r.value,
    observation_count: r.observation_count,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    resolved_at: r.resolved_at,
    resolution: r.resolution as LlmPendingValue["resolution"],
  };
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/llm-observations", requireAuth);
  app.use("/v1/llm-observations", idempotency);
  app.use("/v1/admin/llm-obs/*", requireAuth);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "llm-obs:write");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const observations: LlmObservationInput[] = body.observations;

    // Resolve ticket keys → UUIDs up front so any bad key 422s the whole
    // batch before we touch the DB. Same key referenced multiple times
    // resolves once.
    const ticketIdByKey = new Map<string, string>();
    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i]!;
      if (!obs.ticket_key) continue;
      if (ticketIdByKey.has(obs.ticket_key)) continue;
      try {
        const ticket = await resolveTicket(obs.ticket_key);
        ticketIdByKey.set(obs.ticket_key, ticket.id);
      } catch (err) {
        throw unprocessable(`observation[${i}].ticket_key: ${(err as Error).message}`);
      }
    }

    // Per-dimension counts of unknown values to upsert into the warn-list
    // registry. We aggregate within the batch first so the same model name
    // appearing 50 times in one batch is one upsert with count += 50, not
    // 50 separate upserts.
    const dimCounts = new Map<string, { dimension: Dimension; value: string; count: number }>();
    for (const obs of observations) {
      for (const dim of DIMENSIONS) {
        const value = obs[dim];
        const k = `${dim}\x1f${value}`;
        const existing = dimCounts.get(k);
        if (existing) existing.count += 1;
        else dimCounts.set(k, { dimension: dim, value, count: 1 });
      }
    }

    const { accepted, deduplicated, pending_captured } = await db.transaction(async (tx) => {
      // Insert observations. RETURNING id tells us how many landed — anything
      // not returned was a dedup_key collision.
      const rows = observations.map((obs) => ({
        occurred_at: obs.occurred_at,
        actor_id: auth.user.id,
        ticket_id: obs.ticket_key ? ticketIdByKey.get(obs.ticket_key) ?? null : null,
        service: obs.service,
        operation: obs.operation,
        model: obs.model,
        provider: obs.provider,
        input_tokens: obs.input_tokens,
        output_tokens: obs.output_tokens,
        cache_creation_input_tokens: obs.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: obs.cache_read_input_tokens ?? null,
        latency_ms: obs.latency_ms,
        error_code: obs.error_code ?? null,
        dedup_key: obs.dedup_key ?? null,
        metadata: obs.metadata ?? {},
      }));

      const inserted = await tx
        .insert(schema.llmObservations)
        .values(rows)
        .onConflictDoNothing({ target: schema.llmObservations.dedup_key })
        .returning({ id: schema.llmObservations.id });

      const accepted = inserted.length;
      const deduplicated = observations.length - accepted;

      // Upsert dimension values into the warn-list registry. xmax = 0 is a
      // Postgres-internal trick: on RETURNING, xmax is 0 for freshly-inserted
      // rows and non-zero for updated ones. Lets us tell new captures apart
      // from re-seen values in a single statement.
      const pending: PendingValueCaptured[] = [];
      if (dimCounts.size > 0) {
        const upsertRows = [...dimCounts.values()].map((d) => ({
          dimension: d.dimension,
          value: d.value,
          observation_count: d.count,
        }));
        const results = await tx.execute(sql`
          INSERT INTO llm_obs_pending_values (dimension, value, observation_count)
          VALUES ${sql.join(
            upsertRows.map((r) => sql`(${r.dimension}, ${r.value}, ${r.observation_count})`),
            sql`, `,
          )}
          ON CONFLICT (dimension, value) DO UPDATE
            SET last_seen_at = NOW(),
                observation_count = llm_obs_pending_values.observation_count + EXCLUDED.observation_count
          RETURNING dimension, value, (xmax = 0) AS was_inserted, resolved_at
        `);
        for (const row of results as unknown as Array<{
          dimension: Dimension;
          value: string;
          was_inserted: boolean;
          resolved_at: string | null;
        }>) {
          // Only newly-seen, still-pending values surface in the response.
          // Already-promoted values are "known" — emitting them isn't news.
          if (row.was_inserted && row.resolved_at === null) {
            pending.push({ dimension: row.dimension, value: row.value });
          }
        }
      }

      return { accepted, deduplicated, pending_captured: pending };
    });

    return c.json({ accepted, deduplicated, pending_captured }, 200);
  }) as any);

  // ── warn-list management (admin-only) ──────────────────────────────────────

  app.openapi(listPending, (async (c: any) => {
    checkScope(c, "admin");
    assertInstanceAdmin(c.get("auth").user, "llm-obs pending values");
    const q = c.req.valid("query");
    const conds = [];
    if (q.dimension) conds.push(eq(schema.llmObsPendingValues.dimension, q.dimension));
    if (q.include_resolved !== "true") conds.push(isNull(schema.llmObsPendingValues.resolved_at));

    const rows = await db
      .select()
      .from(schema.llmObsPendingValues)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.llmObsPendingValues.last_seen_at));
    return c.json({ items: rows.map(mapPending) }, 200);
  }) as any);

  const resolvePending = (resolution: LlmPendingResolution) =>
    (async (c: any) => {
      checkScope(c, "admin");
      assertInstanceAdmin(c.get("auth").user, "llm-obs pending values");
      const { id } = c.req.valid("param");
      const [row] = await db
        .update(schema.llmObsPendingValues)
        .set({ resolved_at: new Date().toISOString(), resolution })
        .where(eq(schema.llmObsPendingValues.id, id))
        .returning();
      if (!row) throw notFound("pending value");
      return c.json(mapPending(row), 200);
    }) as any;

  app.openapi(promotePending, resolvePending("promoted"));
  app.openapi(rejectPending, resolvePending("rejected"));
}
