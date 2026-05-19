// Idempotent seed for model_pricing. Run once after the schema migration
// lands; re-run whenever rates change or a new model enters the pipeline.
//
//   DATABASE_URL=postgres://...:5432/switchyard \
//     bun server/scripts/seed-model-pricing.ts
//
// What it does: for each entry below, inserts a row if the (model, provider)
// pair has no current rate (effective_to IS NULL). Existing current rates
// are NOT overwritten — to change a rate, run a manual SQL update that
// closes the old row (sets effective_to) and the script will re-insert the
// new one on next run. Keeps re-runs safe and prevents accidental rate
// regression.
//
// Scope per the SWY-48 decision doc: just claude-opus-4-7 (the pipeline's
// primary paid model) plus zero-cost rows for the local Gemma variants.
// Other models (Sonnet, Haiku, GPT-4o) land in admin UI once they're
// actually used; the cost view returns NULL cost for unpriced observations
// so the gap is visible rather than silently zero.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

interface PricingSeed {
  model: string;
  provider: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_creation_multiplier: number;
  cache_read_multiplier: number;
  notes: string;
}

// Rates as of 2026-05 — verify against vendor pricing pages before relying
// on these for accounting. Anthropic publishes per-million-input-token /
// per-million-output-token. Cache multipliers are applied to
// input_usd_per_mtok (so cache write at 1.25x means cached writes cost
// 1.25 × input rate per cached token; cache read at 0.1x means cached
// reads cost 0.1 × input rate per cached token).
const SEEDS: PricingSeed[] = [
  {
    model: "claude-opus-4-7",
    provider: "anthropic",
    input_usd_per_mtok: 15.0,
    output_usd_per_mtok: 75.0,
    cache_creation_multiplier: 1.25,
    cache_read_multiplier: 0.1,
    notes: "Anthropic public list price as of 2026-05.",
  },
  {
    model: "gemma4:31b",
    provider: "ollama",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    cache_creation_multiplier: 0,
    cache_read_multiplier: 0,
    notes: "Local model. Marginal API cost is zero; electricity/GPU amortization not tracked here.",
  },
  {
    model: "gemma4:e4b",
    provider: "ollama",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    cache_creation_multiplier: 0,
    cache_read_multiplier: 0,
    notes: "Local utility-tier model. See gemma4:31b note.",
  },
];

const NOW = new Date().toISOString();

const client = postgres(DATABASE_URL);
const db = drizzle(client, { schema });

let inserted = 0;
let skipped = 0;

for (const seed of SEEDS) {
  // "Current rate" = the row for (model, provider) with effective_to IS NULL.
  // If one exists, skip — re-runs are no-ops unless the operator has
  // explicitly closed the old row (set effective_to).
  const [existing] = await db
    .select({ id: schema.modelPricing.id })
    .from(schema.modelPricing)
    .where(
      and(
        eq(schema.modelPricing.model, seed.model),
        eq(schema.modelPricing.provider, seed.provider),
        isNull(schema.modelPricing.effective_to),
      ),
    )
    .limit(1);

  if (existing) {
    console.log(`SKIP  ${seed.model} / ${seed.provider} (current rate already present)`);
    skipped++;
    continue;
  }

  await db.insert(schema.modelPricing).values({
    model: seed.model,
    provider: seed.provider,
    input_usd_per_mtok: seed.input_usd_per_mtok,
    output_usd_per_mtok: seed.output_usd_per_mtok,
    cache_creation_multiplier: seed.cache_creation_multiplier,
    cache_read_multiplier: seed.cache_read_multiplier,
    effective_from: NOW,
    effective_to: null,
    notes: seed.notes,
  });
  console.log(
    `INSERT ${seed.model} / ${seed.provider} ($${seed.input_usd_per_mtok}/M in, $${seed.output_usd_per_mtok}/M out)`,
  );
  inserted++;
}

console.log(`\n${inserted} inserted, ${skipped} skipped (already current).`);
await client.end();
