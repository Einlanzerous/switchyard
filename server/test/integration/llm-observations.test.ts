// Phase 5.1.0 integration tests: llm_observations schema + cost view +
// model_pricing constraints.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/llm-observations.test.ts
//
// Covers (DB-level — route logic above this is thin):
//   - insert with dedup_key + ON CONFLICT DO NOTHING for retried batches
//   - multiple NULL dedup_keys coexist (partial unique only enforces non-null)
//   - llm_obs_pending_values upsert tracks first_seen / last_seen / count
//   - llm_observations_with_cost computes input + output + cache multipliers
//   - cost view returns NULL when no pricing row covers occurred_at
//   - model_pricing tstzrange exclusion blocks overlapping (model, provider)
//     periods (so the view can't multiply rows)
//   - tokens-non-negative CHECK constraint rejects negative inputs

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, and, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE llm_observations_daily, llm_obs_pending_values,
        llm_observations, model_pricing, ticket_labels, comments,
        attachments, tickets, project_counters, statuses, status_transitions,
        labels, projects, api_tokens, idempotency_keys, users
        RESTART IDENTITY CASCADE`,
  );
});

async function seedActor() {
  const [user] = await testDb
    .insert(schema.users)
    .values({ name: "n8n-cogitation", type: "agent" })
    .returning();
  return user!;
}

async function seedTicket() {
  const [project] = await testDb
    .insert(schema.projects)
    .values({ key: "OBS", name: "Obs test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb
    .insert(schema.statuses)
    .values({
      project_id: project!.id,
      category: "backlog",
      display_name: "Backlog",
      position: 0,
      is_default: true,
    })
    .returning();
  const [reporter] = await testDb
    .insert(schema.users)
    .values({ name: "reporter", type: "human" })
    .returning();
  const [ticket] = await testDb
    .insert(schema.tickets)
    .values({
      project_id: project!.id,
      number: 1,
      key: "OBS-1",
      type: "task",
      title: "smoke",
      status_id: backlog!.id,
      reporter_id: reporter!.id,
    })
    .returning();
  return ticket!;
}

describe("llm_observations — dedup_key behavior", () => {
  test("ON CONFLICT (dedup_key) DO NOTHING skips repeated dedup_key", async () => {
    const actor = await seedActor();
    const baseRow = {
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      ticket_id: null,
      service: "servo-signal",
      operation: "greenfield",
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
      latency_ms: 1234,
      dedup_key: "servo-signal:exec-1:greenfield:turn-1",
    };

    const first = await testDb
      .insert(schema.llmObservations)
      .values(baseRow)
      .onConflictDoNothing({ target: schema.llmObservations.dedup_key })
      .returning({ id: schema.llmObservations.id });
    expect(first).toHaveLength(1);

    // Same dedup_key, different occurred_at + tokens. Should be skipped.
    const second = await testDb
      .insert(schema.llmObservations)
      .values({ ...baseRow, occurred_at: "2026-05-18T06:00:00Z", input_tokens: 999 })
      .onConflictDoNothing({ target: schema.llmObservations.dedup_key })
      .returning({ id: schema.llmObservations.id });
    expect(second).toHaveLength(0);

    // Stored row is the original — second insert's tokens did not overwrite.
    const [stored] = await testDb.select().from(schema.llmObservations);
    expect(stored!.input_tokens).toBe(100);
  });

  test("NULL dedup_keys do not conflict — partial unique skips them", async () => {
    const actor = await seedActor();
    const row = {
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      ticket_id: null,
      service: "scribe",
      operation: "route",
      model: "gemma4:31b",
      provider: "ollama",
      input_tokens: 50,
      output_tokens: 10,
      latency_ms: 500,
      dedup_key: null,
    };

    await testDb.insert(schema.llmObservations).values(row);
    await testDb.insert(schema.llmObservations).values(row);
    await testDb.insert(schema.llmObservations).values(row);

    const rows = await testDb.select().from(schema.llmObservations);
    expect(rows).toHaveLength(3);
  });
});

describe("llm_observations — CHECK constraints", () => {
  test("negative input_tokens rejected", async () => {
    const actor = await seedActor();
    let err: unknown;
    try {
      await testDb.insert(schema.llmObservations).values({
        occurred_at: "2026-05-18T05:12:59Z",
        actor_id: actor.id,
        service: "x",
        operation: "x",
        model: "x",
        provider: "x",
        input_tokens: -1,
        output_tokens: 0,
        latency_ms: 0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/llm_observations_tokens_non_negative/);
  });
});

describe("llm_obs_pending_values — upsert behavior", () => {
  test("first INSERT creates row with count, second INSERT increments", async () => {
    // Direct execute matches what the route does — exercises the same SQL.
    const first = await testDb.execute(sql`
      INSERT INTO llm_obs_pending_values (dimension, value, observation_count)
      VALUES ('model', 'claude-opus-4-7', 3)
      ON CONFLICT (dimension, value) DO UPDATE
        SET last_seen_at = NOW(),
            observation_count = llm_obs_pending_values.observation_count + EXCLUDED.observation_count
      RETURNING observation_count, (xmax = 0) AS was_inserted
    `);
    expect((first as any)[0].was_inserted).toBe(true);
    expect((first as any)[0].observation_count).toBe(3);

    const second = await testDb.execute(sql`
      INSERT INTO llm_obs_pending_values (dimension, value, observation_count)
      VALUES ('model', 'claude-opus-4-7', 7)
      ON CONFLICT (dimension, value) DO UPDATE
        SET last_seen_at = NOW(),
            observation_count = llm_obs_pending_values.observation_count + EXCLUDED.observation_count
      RETURNING observation_count, (xmax = 0) AS was_inserted
    `);
    expect((second as any)[0].was_inserted).toBe(false);
    expect((second as any)[0].observation_count).toBe(10);
  });
});

describe("model_pricing — tstzrange exclusion constraint", () => {
  test("non-overlapping periods coexist", async () => {
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 15.0,
      output_usd_per_mtok: 75.0,
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: "2026-06-01T00:00:00Z",
    });
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 12.0,
      output_usd_per_mtok: 60.0,
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      effective_from: "2026-06-01T00:00:00Z",
      effective_to: null,
    });

    const rows = await testDb
      .select()
      .from(schema.modelPricing)
      .where(eq(schema.modelPricing.model, "claude-opus-4-7"));
    expect(rows).toHaveLength(2);
  });

  test("overlapping periods rejected for same (model, provider)", async () => {
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 15.0,
      output_usd_per_mtok: 75.0,
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: "2026-06-01T00:00:00Z",
    });

    let err: unknown;
    try {
      await testDb.insert(schema.modelPricing).values({
        model: "claude-opus-4-7",
        provider: "anthropic",
        input_usd_per_mtok: 12.0,
        output_usd_per_mtok: 60.0,
        cache_creation_multiplier: 1.25,
        cache_read_multiplier: 0.1,
        // Overlaps with the row above.
        effective_from: "2026-05-01T00:00:00Z",
        effective_to: null,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/model_pricing_no_overlap/);
  });

  test("same period for a different provider does NOT conflict", async () => {
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 15.0,
      output_usd_per_mtok: 75.0,
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });
    // Different provider — exclusion constraint scopes by (model, provider).
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "bedrock",
      input_usd_per_mtok: 15.0,
      output_usd_per_mtok: 75.0,
      cache_creation_multiplier: 1.0,
      cache_read_multiplier: 1.0,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });
    const rows = await testDb.select().from(schema.modelPricing);
    expect(rows).toHaveLength(2);
  });
});

describe("llm_observations_with_cost — cost view", () => {
  test("computes cost from input + output + cache multipliers", async () => {
    const actor = await seedActor();
    const ticket = await seedTicket();

    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 15.0, // $15 / 1M input tokens
      output_usd_per_mtok: 75.0, // $75 / 1M output tokens
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });

    await testDb.insert(schema.llmObservations).values({
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      ticket_id: ticket.id,
      service: "servo-signal",
      operation: "greenfield",
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 1_000_000, // exactly 1M → $15.00
      output_tokens: 1_000_000, // exactly 1M → $75.00
      cache_creation_input_tokens: 1_000_000, // 1M × 15 × 1.25 = $18.75
      cache_read_input_tokens: 1_000_000, // 1M × 15 × 0.1 = $1.50
      latency_ms: 1234,
    });

    const rows = (await testDb.execute(
      sql`SELECT cost_usd FROM llm_observations_with_cost`,
    )) as unknown as Array<{ cost_usd: number }>;
    expect(rows).toHaveLength(1);
    // 15 + 75 + 18.75 + 1.50 = 110.25
    expect(rows[0]!.cost_usd).toBeCloseTo(110.25, 4);
  });

  test("returns NULL cost when no pricing covers occurred_at", async () => {
    const actor = await seedActor();
    await testDb.insert(schema.modelPricing).values({
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_usd_per_mtok: 15.0,
      output_usd_per_mtok: 75.0,
      cache_creation_multiplier: 1.25,
      cache_read_multiplier: 0.1,
      // Period ends BEFORE the observation.
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: "2026-03-01T00:00:00Z",
    });
    await testDb.insert(schema.llmObservations).values({
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      service: "servo-signal",
      operation: "greenfield",
      model: "claude-opus-4-7",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
      latency_ms: 100,
    });

    const rows = (await testDb.execute(
      sql`SELECT cost_usd FROM llm_observations_with_cost`,
    )) as unknown as Array<{ cost_usd: number | null }>;
    expect(rows[0]!.cost_usd).toBeNull();
  });

  test("local-zero pricing yields cost_usd = 0", async () => {
    const actor = await seedActor();
    await testDb.insert(schema.modelPricing).values({
      model: "gemma4:31b",
      provider: "ollama",
      input_usd_per_mtok: 0,
      output_usd_per_mtok: 0,
      cache_creation_multiplier: 0,
      cache_read_multiplier: 0,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });
    await testDb.insert(schema.llmObservations).values({
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      service: "scribe",
      operation: "route",
      model: "gemma4:31b",
      provider: "ollama",
      input_tokens: 9_999,
      output_tokens: 1_234,
      latency_ms: 50,
    });

    const rows = (await testDb.execute(
      sql`SELECT cost_usd FROM llm_observations_with_cost`,
    )) as unknown as Array<{ cost_usd: number }>;
    expect(rows[0]!.cost_usd).toBe(0);
  });

  test("energy-priced local model costs by watts × latency × $/kWh", async () => {
    const actor = await seedActor();
    // No llm_obs_usd_per_kwh row → view COALESCEs to the 0.17 default.
    await testDb.insert(schema.modelPricing).values({
      model: "gemma4:31b",
      provider: "ollama",
      input_usd_per_mtok: 0,
      output_usd_per_mtok: 0,
      cache_creation_multiplier: 0,
      cache_read_multiplier: 0,
      avg_power_watts: 300, // R9700 board power
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });
    await testDb.insert(schema.llmObservations).values({
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      service: "servo-signal",
      operation: "greenfield",
      model: "gemma4:31b",
      provider: "ollama",
      input_tokens: 9_999,
      output_tokens: 1_234,
      latency_ms: 3_600_000, // exactly 1 hour → 0.3 kW × 1h × $0.17 = $0.051
    });

    const rows = (await testDb.execute(
      sql`SELECT cost_usd FROM llm_observations_with_cost`,
    )) as unknown as Array<{ cost_usd: number }>;
    expect(rows[0]!.cost_usd).toBeCloseTo(0.051, 6);
  });

  test("measured metadata.energy_wh overrides the configured average", async () => {
    const actor = await seedActor();
    await testDb.insert(schema.modelPricing).values({
      model: "gemma4:31b",
      provider: "ollama",
      input_usd_per_mtok: 0,
      output_usd_per_mtok: 0,
      cache_creation_multiplier: 0,
      cache_read_multiplier: 0,
      avg_power_watts: 300, // ignored when energy_wh is present
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    });
    await testDb.insert(schema.llmObservations).values({
      occurred_at: "2026-05-18T05:12:59Z",
      actor_id: actor.id,
      service: "servo-signal",
      operation: "greenfield",
      model: "gemma4:31b",
      provider: "ollama",
      input_tokens: 10,
      output_tokens: 10,
      latency_ms: 50, // ignored — energy_wh wins
      metadata: { energy_wh: 500 }, // 0.5 kWh × $0.17 = $0.085
    });

    const rows = (await testDb.execute(
      sql`SELECT cost_usd FROM llm_observations_with_cost`,
    )) as unknown as Array<{ cost_usd: number }>;
    expect(rows[0]!.cost_usd).toBeCloseTo(0.085, 6);
  });
});

describe("llm_observations — indexes exist (smoke)", () => {
  test("pg_indexes shows the four named indexes plus the dedup partial unique", async () => {
    const rows = (await testDb.execute(
      sql`SELECT indexname FROM pg_indexes
          WHERE tablename = 'llm_observations'
          ORDER BY indexname`,
    )) as unknown as Array<{ indexname: string }>;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("llm_observations_occurred_at_idx");
    expect(names).toContain("llm_observations_ticket_idx");
    expect(names).toContain("llm_observations_service_op_idx");
    expect(names).toContain("llm_observations_actor_idx");
    expect(names).toContain("llm_observations_dedup_key_unique");
  });
});
