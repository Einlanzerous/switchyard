# SWY-48 — Observability for the agentic pipeline (decision)

Status: **resolved — ready to implement**.
Ticket: SWY-48 (Phase 5.1, parent SWY-45).
Decision owner: magos.

## Review notes

Local-AI pre-review surfaced five amendments that have been folded in
below: per-item idempotency via explicit `dedup_key` (vs. relying on
the HTTP `Idempotency-Key` header alone), daily rollups (vs. monthly)
to keep the global Insights view snappy at ~2.6M raw rows/yr, on-the-fly
cost computation via a SQL view over `model_pricing` (vs. storing
`cost_usd` and running backfill jobs on price changes), warn-only
cardinality management (vs. hard-reject), and an explicit
`(ticket_id, occurred_at desc)` index for the HITL stall detector's
"absence-of-data" query shape. Resolutions to the original 8 open
questions are in the "Resolutions" section below.

## Context

The agentic pipeline (Vox-Dictate → Cogitation Engine → Servo-Signal agents
→ Switchyard) has grown to the point where capacity / cost / cycle-time
questions can no longer be answered by intuition. "Which model spends the
most per shipped ticket?" "Did Gemma 31b regress on greenfield latency
after the bake-off swap?" "Is the verifier rejecting more diffs this week
than last?" None of these have a place to land today.

Two distinct observability needs sit underneath that, and conflating them
has been the source of every false start so far:

1. **Infra health** — DB up, containers running, latency normal, queue
   depths sane. Already covered by switchyard's own `/healthz` admin page
   and the existing Datadog free-tier deploy on `construct-server`.
2. **Pipeline performance + LLM cost** — per-call token spend, latency
   distributions, cache hit rate, error rate by failure mode, cycle-time
   decomposition (planning vs. building vs. reviewing), cost-per-ticket
   rollups, HITL stalls. No store today.

The user's stated framing makes the split concrete: "If my server is down,
I'm not going to look at Datadog — but triaging a service or LLM
performance is totally something I'd wanna do." Infra obs is alerting that
doesn't get watched. Performance obs is on-demand investigation that
happens *in switchyard*, because that's where the ticket already is.

## Constraints

- **No Grafana.** User preference; rules out OTel-with-Grafana-frontend
  variants regardless of backend.
- **Datadog LLM Observability is cost-prohibitive at homelab scale.** The
  per-trace + per-event pricing on the LLM Observability product line
  scales linearly with agent traffic; agentic pipelines emit far more
  events per "unit of work" than traditional services, so the budget math
  doesn't survive a single bake-off week.
- **Switchyard is the triage entrypoint.** When something is slow, the
  ticket is the question. Anywhere else loses to one-click immediacy.
- **Imperium-loop stays whole** (PHASES.md §5 locked decision). Whatever
  ships, n8n + Servo-Signal + Autosavant keep running as-is; observability
  is additive, not a refactor.
- **Per-actor tokens stay the audit model.** Whoever emits LLM
  observations does so authenticated as their canonical actor.

## Options considered

| | Infra obs | Perf / LLM obs | Net cost | Build cost |
|---|---|---|---|---|
| **A. Datadog full + LLM Observability** | Datadog | Datadog LLM Obs | $$$ | Low |
| **B. SigNoz (self-hosted OTel all-in-one)** | SigNoz | SigNoz custom dashboards | $ infra | Medium |
| **C. OTel + Grafana** | Grafana | Grafana | $ infra | Medium | *— ruled out by constraint*
| **D. OTel + bespoke switchyard tool** | Datadog (kept) | switchyard-native via OTel collector | $ minimal | Medium-high |
| **E. Hybrid: Datadog (infra) + switchyard-native LLM** | Datadog (kept) | switchyard-native, direct HTTP | $ minimal | Low |

**Why E (hybrid, direct HTTP) wins:**

- The infra side is already done. Datadog free tier covers the construct-net
  baseline; nothing on the agentic side needs a different infra story.
- Switchyard already owns half the LLM-perf data shape: tickets, status
  transitions (cycle time), actors (per-agent attribution). Adding LLM
  per-call observations is a single new table + endpoint + tab.
- Direct HTTP `POST /v1/llm-observations` skips the OTel collector tax.
  OTel becomes worth setting up when there's a second consumer to fan out
  to; there isn't.
- Triage happens where the user already is. A switchyard Insights → LLM
  tab beats any "context switch to dashboard tool" workflow.

**Why not D (OTel + bespoke):** OTel SDKs add a dependency to every emitter
(n8n nodes, Servo-Signal Go code, autosavant-bot) and a collector container
to operate. If a third-party tool ever becomes worth integrating, OTel
ingestion can be bolted onto the same `llm_observations` storage later as
an alternate write path. Easier to add OTel to the current design than to
extract bespoke ergonomics from an OTel-first design.

**Why not B (SigNoz):** Would mean ripping out Datadog for infra (working
fine) and re-doing the dashboards in a not-yet-loved tool. SigNoz is the
right answer if the requirement were "one self-hosted system for
everything"; it isn't.

## Proposed shape

### Storage

New table `llm_observations`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `occurred_at` | timestamptz | When the LLM call happened (client-supplied) |
| `actor_id` | uuid fk → users | Which agent token made the call |
| `ticket_id` | uuid fk → tickets, nullable | Null for ambient ops (scaffolding, scribe routing) |
| `service` | text | `n8n-cogitation` / `servo-signal` / `autosavant-bot` / `switchyard-mcp` |
| `operation` | text | `planning` / `greenfield` / `refinement` / `verify_greenfield` / `scribe` / etc. |
| `model` | text | `claude-opus-4-7` / `gemma4:31b` / `gpt-4o` / etc. |
| `provider` | text | `anthropic` / `ollama` / `openai` / etc. |
| `input_tokens` | int | |
| `output_tokens` | int | |
| `cache_creation_input_tokens` | int nullable | Anthropic-specific |
| `cache_read_input_tokens` | int nullable | Anthropic-specific |
| `latency_ms` | int | End-to-end LLM call duration |
| `error_code` | text nullable | `rate_limited` / `content_filter` / `network` / `timeout` / `tool_call_malformed` / etc. |
| `dedup_key` | text nullable | Per-observation natural key for at-most-once writes. Partial unique index where not null. Suggested shape: `<service>:<execution_id>:<node_or_op>:<turn>`. |
| `metadata` | jsonb | Free-form: `{tool_calls_count, turn_index, session_id, ...}` |
| `created_at` | timestamptz default now() | Server-side insert time |

Indexes:

- `(occurred_at desc)` — global time-range queries.
- `(ticket_id, occurred_at desc)` — per-ticket cost decomposition AND the
  HITL stall detector's "max(occurred_at) WHERE ticket_id = X" query.
  Explicit because the stall detector is an absence-of-data query and
  needs index-only-scan-friendly access to avoid sequential scan as
  the table grows.
- `(service, operation, occurred_at)` — service+operation breakdowns.
- `(actor_id, occurred_at)` — per-actor breakdowns.
- Partial unique on `dedup_key WHERE dedup_key IS NOT NULL` — enables
  `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` for at-most-once writes.

**Cost is computed on-the-fly, not stored.** A separate `model_pricing`
table holds rates, and a view `llm_observations_with_cost` joins to it.
This eliminates the backfill-on-price-change operational burden.

`model_pricing` columns: `model`, `provider`, `input_usd_per_mtok`,
`output_usd_per_mtok`, `cache_creation_multiplier`,
`cache_read_multiplier`, `effective_from`, `effective_to nullable`.
A `tstzrange` exclusion constraint on
`(model, provider, tstzrange(effective_from, effective_to))` prevents
overlapping pricing periods (which would multiply rows on the join).
The current rate for a model has `effective_to IS NULL`; adding a new
rate closes the previous row by setting its `effective_to` to the new
rate's `effective_from`. Local models seed with all-zero rates so
joins still resolve cleanly.

### Endpoint

`POST /v1/llm-observations` (bulk-friendly):

```jsonc
{
  "observations": [
    {
      "occurred_at": "2026-05-18T05:12:59Z",
      "ticket_key": "SWY-36",          // resolved to ticket_id server-side
      "service": "servo-signal",
      "operation": "greenfield",
      "model": "claude-opus-4-7",
      "provider": "anthropic",
      "input_tokens": 12450,
      "output_tokens": 880,
      "cache_creation_input_tokens": 1024,
      "cache_read_input_tokens": 10000,
      "latency_ms": 4321,
      "metadata": { "turn_index": 7, "tool_calls_count": 2 }
    }
  ]
}
```

- Actor inferred from bearer token; no actor field in the body.
- **Two-layer dedup:**
  - The HTTP `Idempotency-Key` header applies to the **request** (same
    key within 24h returns the cached response), matching every other
    mutation endpoint.
  - Each observation may carry an optional `dedup_key` field. Server
    writes via `INSERT ... ON CONFLICT (dedup_key) DO NOTHING`, so a
    partial replay of a bulk batch is safe — observations already
    written get skipped, new ones land. Per-item dedup is the right
    grain here because emitters retry batches, not individual calls.
- New scope `llm-obs:write` minted per-actor; existing tokens get it via
  re-mint, not silent grant.
- **Cardinality management is warn-list, not allow-list.** Unknown
  service/operation/model values land successfully and are flagged in
  the Admin → Observability view as "pending review." The admin can
  one-click promote (writes the value to the canonical
  `system_settings.llm_obs_known_values`) or reject (future writes with
  that value 422). Rejected values cease to write but historical rows
  stay queryable. Avoids the "pipeline silently broken at 3am because a
  model name changed" failure mode while still catching typo growth.

### UI: Insights → LLM tab

Two scopes, share components:

- **Global** (`/insights/llm`) — pipeline-wide view.
- **Per-project** (`/projects/:key/insights/llm`) — filtered to tickets in
  that project.

Tiles + charts (first cut):

1. **KPI strip** — cost this week (with WoW Δ), p95 latency (with Δ),
   error rate (with Δ), cache hit rate.
2. **Token spend over time** — stacked area, weekly buckets, grouped by
   model. Click to drill into per-operation breakdown.
3. **Cost-per-ticket leaderboard** — top 20 most-expensive shipped tickets
   in the time window, with per-operation cost decomposition. Click → ticket.
4. **Latency distribution** — p50/p95/p99 per `(model, operation)`, table
   form. Sparkline shows last 14 days of p95.
5. **Error rate by code** — small bar chart, time-bucketed.
6. **HITL stall detector** — list of tickets `in_progress` for >N hours
   with no LLM activity in the last M hours. N + M configurable via
   `system_settings`.

All six tiles read from `llm_observations_with_cost` (the cost-joined
view) + `llm_observations_daily` (the rollup; see below) + the existing
event log. No external dependency.

**Daily rollups keep the global view snappy.** A scheduled job rolls
raw observations into `llm_observations_daily` (same dimensions:
`bucket_date, service, operation, model, provider, actor_id, ticket_id`;
sum-aggregated metrics: `call_count, input_tokens, output_tokens,
cache_creation_tokens, cache_read_tokens, sum_latency_ms,
p50_latency_ms, p95_latency_ms, p99_latency_ms, cost_usd_at_rollup,
error_count`). The job runs hourly to keep "today" fresh while still
amortizing the heavy aggregations. Global KPI strip + time-series read
from `llm_observations_daily`; per-ticket leaderboard and
HITL detector read from raw `llm_observations` (small per-ticket row
counts make this cheap). Cost at rollup time is *frozen into the
rollup row* — no retroactive recomputation when pricing changes; only
new rollup buckets reflect the new rates. Historical accuracy beats
revisionism here.

### Emit-side work (lives in imperium-loop, not this repo)

- **Cogitation Engine n8n workflows** — append a "Log LLM call" HTTP node
  after each model invocation (Scribe, normalizer, planning, greenfield,
  refinement, verifier). Idempotency key from `(n8n_execution_id, node_id,
  turn_index)`.
- **Servo-Signal** — `run_planning_agent` and `run_greenfield_agent` emit
  per-turn after the model call returns. Already has the turn loop in
  `servo-signal/greenfield.go`; one extra HTTP POST per turn.
- **Autosavant-bot** — emit on Discord-prompt LLM calls.

Single shared `SWITCHYARD_TOKEN` per service (already minted, see
`~/imperium-loop/CLAUDE.md` per-actor mapping).

## Resolutions

1. **Cost computation:** ✅ **server, on-the-fly via SQL view.** Drops the
   stored `cost_usd` column from `llm_observations`; computation lives in
   `llm_observations_with_cost` joining to `model_pricing` on
   `(model, provider)` where `occurred_at` falls inside the pricing
   period. Daily rollups freeze cost at rollup time (no retroactive
   recompute). Local-AI amendment to the original proposal — eliminates
   the backfill-on-price-change burden cleanly.
2. **Retention:** ✅ **180 days raw, daily rollups forever, configurable.**
   Half a year of raw covers the realistic "what changed last quarter"
   investigation window. `system_settings.llm_obs_retention_days` (default
   180) drives the cleanup job — bump or shrink per appetite without code
   changes.
3. **Bulk vs single endpoint:** ✅ **bulk as proposed.** Array of
   observations; emitters batch when convenient, send single-element
   arrays when not.
4. **Cache token attribution:** ✅ **as proposed.** Separate columns for
   creation vs. read; hit-rate formula
   `cache_read_input_tokens / (cache_creation_input_tokens + cache_read_input_tokens + input_tokens)`.
5. **Cardinality management:** ✅ **warn-list, not allow-list** (local-AI
   amendment). Unknown values write successfully and surface in Admin →
   Observability with one-click promote / reject. Avoids the "pipeline
   silently 422-ing because a model name shifted" failure mode while
   still catching typo growth.
6. **Overlap with Phase 5.2 plugin contract:** ✅ **switchyard owns LLM
   data directly.** The 5.2 plugin contract (SWY-47) is reserved for
   genuinely-external state (live n8n execution snapshots, autosavant-bot
   in-flight prompts) — LLM obs is local because the data shape is
   already half-owned (cycle time, actors, tickets).
7. **Alerting:** ✅ **defer.** Let raw data accumulate for 2–4 weeks
   post-launch, then build alerts on patterns observed, not patterns
   imagined. Initial implementation surfaces HITL stalls as a UI tile
   (already in the sketch), not a paging alert.
8. **Ambient ops (LLM calls with no ticket):** ✅ **`ticket_id IS NULL`,
   no sentinel.** UI groups these as "Ambient" in the cost leaderboard.

Additional resolutions from local-AI review (folded into "Proposed shape"
above):

- **Idempotency granularity:** explicit per-observation `dedup_key`
  column with partial unique index; HTTP `Idempotency-Key` header still
  applies at the request layer for response caching. Partial batch
  replays are safe.
- **HITL stall detector index:** `(ticket_id, occurred_at desc)` on raw
  `llm_observations` — explicit support for the "max(occurred_at) WHERE
  ticket_id = X" query shape that absence-of-data detection needs.
- **`model_pricing` overlap prevention:** `tstzrange` exclusion
  constraint on `(model, provider, range(effective_from, effective_to))`
  so the cost-view join can't multiply rows.

## Non-goals

- **Replacing Datadog** for infra metrics. Keep it.
- **Tracing.** Distributed traces across n8n + Servo-Signal + Switchyard
  would be lovely but the value-to-effort ratio is poor at homelab scale;
  per-call metrics buy 80% of the debugging value. If we ever want traces,
  OTel ingestion bolts onto the same `llm_observations` storage.
- **Real-time dashboard refresh.** 60s polling on the LLM tab is plenty;
  no SSE / WebSocket plumbing.
- **Multi-tenant isolation.** Single org, single user. Always.
- **Prometheus-style PromQL.** SQL against `llm_observations` covers
  every ad-hoc question we have. If a query keeps showing up, it becomes
  a saved view in the UI.

## Implementation skeleton

1. **5.1.0 — Schema + endpoint.** Drizzle migration for
   `llm_observations` (with `dedup_key` partial unique + the four
   indexes), `model_pricing` (with `tstzrange` exclusion constraint),
   `llm_observations_with_cost` view, `llm_observations_daily` rollup
   table. Seed `model_pricing` with current Anthropic / Ollama-local /
   OpenAI rates. Add `POST /v1/llm-observations` route (bulk, with
   per-item ON CONFLICT dedup), `llm-obs:write` scope, Zod schemas,
   OpenAPI regen, integration test (per-item dedup, warn-list capture,
   actor inference).
2. **5.1.1 — Emit-side wiring (imperium-loop).** Cogitation Engine n8n
   nodes append "Log LLM call" HTTP node with `dedup_key =
   <service>:<n8n_execution_id>:<node_id>:<turn_index>`; Servo-Signal
   greenfield/planning agents emit per-turn with equivalent key shape;
   autosavant-bot emits on Discord-prompt LLM calls. Lives in
   `~/imperium-loop`, gated on 5.1.0 landing.
3. **5.1.2 — Switchyard Insights → LLM tab UI.** Six tiles per sketch
   above. Global tiles read `llm_observations_daily`; per-ticket +
   HITL tiles read raw `llm_observations`. Reads only; no mutation.
   Admin → Observability page hosts the warn-list promote/reject UI.
4. **5.1.3 — Rollup + retention.** Hourly rollup job into
   `llm_observations_daily`, raw retention configurable via
   `system_settings.llm_obs_retention_days` (default 180), scheduled
   cleanup job. Daily rollups persist forever.
5. **5.1.4 — (Deferred until data exists)** Alerts. Pattern-driven, not
   pre-imagined.

Phase 5.1 closes when 5.1.0 + 5.1.2 + 5.1.3 land with data flowing from
at least two emitters (Cogitation Engine planning + Servo-Signal
greenfield). 5.1.1 finishes itself via imperium-loop's own tracker.
