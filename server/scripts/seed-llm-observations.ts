// Dev-only sample LLM observations so the rollup job + (Phase 5.1.2) Insights
// LLM tab have realistic data locally — emit-side wiring lives in imperium-loop
// (Phase 5.1.1) and won't be producing data in a dev checkout.
//
// Run from the host with the dev DATABASE_URL set:
//
//   DATABASE_URL=postgres://switchyard_user:...@localhost:5432/switchyard \
//     bun server/scripts/seed-llm-observations.ts [count]
//
// Idempotent via dedup_key = `sample:<n>` + ON CONFLICT DO NOTHING, so
// re-running tops up to `count` rather than duplicating. Spreads observations
// over the last 14 days across the seeded priced models so costs resolve.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";
import { backfillRollup } from "../src/lib/llm-obs/rollup.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}
const COUNT = Number(process.argv[2] ?? 300);

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

// (service, operation, model, provider) tuples matching the priced seed rows.
const PROFILES: Array<{
  service: string;
  operation: string;
  model: string;
  provider: string;
  baseLatency: number;
}> = [
  { service: "n8n-cogitation", operation: "planning", model: "claude-opus-4-7", provider: "anthropic", baseLatency: 6_000 },
  { service: "servo-signal", operation: "greenfield", model: "claude-opus-4-7", provider: "anthropic", baseLatency: 9_000 },
  { service: "servo-signal", operation: "refinement", model: "claude-sonnet-4-6", provider: "anthropic", baseLatency: 4_000 },
  { service: "servo-signal", operation: "verify_greenfield", model: "gemma4:31b", provider: "ollama", baseLatency: 18_000 },
  { service: "n8n-cogitation", operation: "scribe", model: "gemma4:31b", provider: "ollama", baseLatency: 12_000 },
  { service: "autosavant-bot", operation: "hitl_prompt", model: "claude-haiku-4-5", provider: "anthropic", baseLatency: 1_500 },
];

const ERROR_CODES = ["rate_limited", "timeout", "content_filter"];

const jitter = (base: number) => Math.round(base * (0.6 + Math.random() * 0.9));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

async function main() {
  const actors = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(sql`${schema.users.name} IN ('claude', 'n8n-cogitation', 'servo-signal', 'autosavant-bot')`);
  if (actors.length === 0) {
    console.error("no agent actors found — run the production seed first");
    process.exit(1);
  }

  // A handful of real ticket ids to attribute cost to; rest stay ambient (NULL).
  const tickets = await db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .limit(20);
  const ticketIds = tickets.map((t) => t.id);

  const rows: Array<typeof schema.llmObservations.$inferInsert> = [];
  for (let i = 0; i < COUNT; i++) {
    const p = pick(PROFILES);
    const daysAgo = Math.random() * 14;
    const occurred = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const isAnthropic = p.provider === "anthropic";
    const errored = Math.random() < 0.06;
    rows.push({
      occurred_at: occurred,
      actor_id: pick(actors).id,
      // ~35% ambient (no ticket), else attribute to a random ticket if any.
      ticket_id: ticketIds.length && Math.random() > 0.35 ? pick(ticketIds) : null,
      service: p.service,
      operation: p.operation,
      model: p.model,
      provider: p.provider,
      input_tokens: 2_000 + Math.floor(Math.random() * 40_000),
      output_tokens: 200 + Math.floor(Math.random() * 4_000),
      cache_creation_input_tokens: isAnthropic ? Math.floor(Math.random() * 4_000) : null,
      cache_read_input_tokens: isAnthropic ? Math.floor(Math.random() * 30_000) : null,
      latency_ms: jitter(p.baseLatency),
      error_code: errored ? pick(ERROR_CODES) : null,
      dedup_key: `sample:${i}`,
      metadata: { sample: true, turn_index: Math.floor(Math.random() * 12) },
    });
  }

  // Insert in chunks; ON CONFLICT (dedup_key) DO NOTHING keeps re-runs idempotent.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await db
      .insert(schema.llmObservations)
      .values(chunk)
      .onConflictDoNothing({ target: schema.llmObservations.dedup_key })
      .returning({ id: schema.llmObservations.id });
    inserted += res.length;
  }

  console.log(`[seed-llm-obs] inserted ${inserted} new observations (target ${COUNT}).`);

  // Backfill the daily rollup over the full sample window so the daily-backed
  // tiles (KPI / token-spend / latency / error-rate) populate immediately —
  // the hourly job's 2-day window can't reach 14 days of history.
  const rolled = await backfillRollup(db as never, 20);
  console.log(`[seed-llm-obs] backfilled ${rolled} daily rollup rows.`);

  await seedHitlStalls();
  console.log("[seed-llm-obs] cost preview (top by frozen cost over last 14d):");
  const preview = (await db.execute(sql`
    SELECT model, provider,
           COUNT(*)::int AS calls,
           ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
    FROM llm_observations_with_cost
    WHERE occurred_at >= now() - INTERVAL '14 days'
    GROUP BY model, provider
    ORDER BY cost_usd DESC NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;
  for (const r of preview) {
    console.log(`  ${r.provider}/${r.model}: ${r.calls} calls, $${r.cost_usd}`);
  }

  await client.end();
}

// Create a couple of in_progress tickets backdated past the HITL threshold with
// no LLM activity, so the stall detector has examples. The BEFORE UPDATE bump
// trigger means updated_at must be set at INSERT time (it can't be backdated via
// UPDATE). Idempotent via the "[HITL demo]" title marker.
async function seedHitlStalls() {
  const projRes = await db.execute(sql`
    SELECT p.id AS project_id, p.key AS project_key, s.id AS status_id
    FROM projects p
    JOIN statuses s ON s.project_id = p.id
    WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND s.category = 'in_progress'
    ORDER BY (p.key = 'SAMPLE') DESC, p.created_at
    LIMIT 1
  `);
  const proj = (((projRes as any).rows ?? projRes)[0]) as
    | { project_id: string; project_key: string; status_id: string }
    | undefined;
  if (!proj) {
    console.log("[seed-llm-obs] no in_progress status found; skipping HITL examples.");
    return;
  }

  const existing = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM tickets WHERE title LIKE '[HITL demo]%' AND deleted_at IS NULL`,
  );
  if (Number((((existing as any).rows ?? existing)[0]).n) >= 2) {
    console.log("[seed-llm-obs] HITL demo stalls already present.");
    return;
  }

  const [reporter] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.name, "claude"))
    .limit(1);
  if (!reporter) return;

  const examples = [
    { title: "[HITL demo] Awaiting plan approval", hours: 30 },
    { title: "[HITL demo] Blocked on human review", hours: 54 },
  ];
  for (const ex of examples) {
    const numRes = await db.execute(sql`
      UPDATE project_counters SET last_used_number = last_used_number + 1
      WHERE project_id = ${proj.project_id} RETURNING last_used_number
    `);
    const number = Number((((numRes as any).rows ?? numRes)[0]).last_used_number);
    // No `key` column — the ticket key is derived (project.key + number) at read.
    await db.execute(sql`
      INSERT INTO tickets
        (project_id, number, title, type, reporter_id, status_id, position, created_at, updated_at)
      VALUES (
        ${proj.project_id}, ${number},
        ${ex.title}, 'task', ${reporter.id}, ${proj.status_id},
        EXTRACT(EPOCH FROM now()) * 1000,
        now() - (${ex.hours} * INTERVAL '1 hour'),
        now() - (${ex.hours} * INTERVAL '1 hour')
      )
    `);
    console.log(`[seed-llm-obs] HITL stall example: ${proj.project_key}-${number} (${ex.hours}h)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
