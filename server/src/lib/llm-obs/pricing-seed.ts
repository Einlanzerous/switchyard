// SWY-48 Phase 5.1 — canonical model_pricing seed rows.
//
// Token-priced rows (Anthropic / OpenAI) carry USD-per-Mtok rates; cost is
// computed in the llm_observations_with_cost view. Energy-priced rows (local
// Ollama models) carry `avg_power_watts` instead — the view costs them by
// (watts × latency × $/kWh) using the llm_obs_usd_per_kwh setting.
//
// Anthropic rates per the claude-api reference (cache create 1.25× input,
// cache read 0.1× input). `effective_from` is a fixed historical anchor so the
// point-in-time join resolves for existing + backfilled observations. Adding a
// new rate later = close the old row's effective_to and insert a new one.
//
// Unknown models that show up in the wild aren't seeded here — they land in the
// warn-list (llm_obs_pending_values) for one-click admin review, by design.

export const PRICING_EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

export type PricingSeedRow = {
  model: string;
  provider: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_creation_multiplier: number;
  cache_read_multiplier: number;
  avg_power_watts: number | null;
  notes: string | null;
};

const anthropic = (
  model: string,
  input_usd_per_mtok: number,
  output_usd_per_mtok: number,
): PricingSeedRow => ({
  model,
  provider: "anthropic",
  input_usd_per_mtok,
  output_usd_per_mtok,
  cache_creation_multiplier: 1.25,
  cache_read_multiplier: 0.1,
  avg_power_watts: null,
  notes: null,
});

// Local Ollama models: zero token rates, energy-priced at the configured watts.
// 300W is the AMD Radeon AI Pro R9700 board power (a slightly conservative
// upper bound vs. sustained inference draw) — tune via Settings, not code.
const ollamaLocal = (model: string, avg_power_watts = 300): PricingSeedRow => ({
  model,
  provider: "ollama",
  input_usd_per_mtok: 0,
  output_usd_per_mtok: 0,
  cache_creation_multiplier: 0,
  cache_read_multiplier: 0,
  avg_power_watts,
  notes: "energy-priced (local GPU); watts is board power, tune as needed",
});

const openai = (
  model: string,
  input_usd_per_mtok: number,
  output_usd_per_mtok: number,
): PricingSeedRow => ({
  model,
  provider: "openai",
  input_usd_per_mtok,
  output_usd_per_mtok,
  // OpenAI cached input is ~0.5× input; no separate cache-write premium.
  cache_creation_multiplier: 1.0,
  cache_read_multiplier: 0.5,
  avg_power_watts: null,
  notes: "approximate rates — verify before relying on OpenAI cost figures",
});

export const PRICING_SEED: PricingSeedRow[] = [
  // Anthropic — current per-Mtok rates (claude-api reference).
  anthropic("claude-opus-4-8", 5, 25),
  anthropic("claude-opus-4-7", 5, 25),
  anthropic("claude-sonnet-4-6", 3, 15),
  anthropic("claude-haiku-4-5", 1, 5),
  // Local inference via imperium-loop (Gemma on the R9700).
  ollamaLocal("gemma4:31b"),
  ollamaLocal("gemma4:e4b"), // utility-tier local model

  // OpenAI — approximate; flagged in notes. Surfaces real (non-zero) cost if
  // the pipeline ever routes to OpenAI, correctable in one row edit.
  openai("gpt-4o", 2.5, 10),
  openai("gpt-4o-mini", 0.15, 0.6),
];
