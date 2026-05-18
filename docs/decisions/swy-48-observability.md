# SWY-48 — Observability for the agentic pipeline (decision)

Status: **draft** — open questions at the bottom.
Ticket: SWY-48 (Phase 5.1, parent SWY-45).
Decision owner: magos.

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
| `cost_usd` | numeric(10,6) nullable | Server-computed from model pricing table; NULL for local models |
| `error_code` | text nullable | `rate_limited` / `content_filter` / `network` / `timeout` / `tool_call_malformed` / etc. |
| `metadata` | jsonb | Free-form: `{tool_calls_count, turn_index, session_id, ...}` |
| `created_at` | timestamptz default now() | Server-side insert time |

Indexes: `(occurred_at desc)`, `(ticket_id, occurred_at)`,
`(service, operation, occurred_at)`, `(actor_id, occurred_at)`.

A separate `model_pricing` table (model, provider, input_usd_per_mtok,
output_usd_per_mtok, cache_creation_multiplier, cache_read_multiplier,
effective_from, effective_to) lets the server compute `cost_usd` at insert
time without hardcoding rates in agent code. Local models default to 0.

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
- Idempotency-key header supported (same shape as other mutations).
- New scope `llm-obs:write` minted per-actor; existing tokens get it via
  re-mint, not silent grant.
- Schema validation rejects unknown service/operation values to keep
  cardinality bounded (allow-list lives in `system_settings`).

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

All five tiles read from `llm_observations` + the existing event log; no
external dependency.

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

## Open questions

The following need answers before any code lands. Some can be deferred to
follow-up tickets:

1. **Cost computation: client or server?** Recommendation: **server**, via
   a `model_pricing` table. Emitters don't track price changes; switchyard
   does. Cost re-computation on price changes is a recurring backfill job.
2. **Retention.** Recommendation: **365 days raw, then aggregate to
   monthly `llm_observations_monthly_rollup`**. Raw rows for 1 year covers
   any "what changed last quarter" question; monthly aggregates are
   forever. Open: is 365d too much? Initial volume estimate: ~50k rows /
   week at current pipeline cadence = ~2.6M rows / yr. Comfortable in
   postgres.
3. **Bulk vs single endpoint.** Recommendation: **bulk by default** (array
   of observations), with single-observation as a degenerate case (array
   of one). Lets emitters batch when convenient (n8n end-of-workflow flush)
   without forcing it (greenfield agents POST per turn for liveness).
4. **Cache token attribution.** Anthropic returns both `cache_creation`
   and `cache_read` counts per call. Store both as separate columns (per
   schema above); compute hit rate as
   `cache_read_input_tokens / (cache_creation_input_tokens + cache_read_input_tokens + input_tokens)`.
5. **Cardinality cap.** Service/operation/model are all allow-listed via
   `system_settings`; new values rejected with `unprocessable` until added.
   Prevents typo-induced unbounded growth.
6. **Overlap with Phase 5.2 plugin contract (SWY-47).** PHASES.md §5.1
   mentions "Surface 3 KPI tiles in switchyard via the SWY-47 plugin
   contract." With switchyard-native LLM obs (this doc), three of those
   tiles can be drawn from local data instead of a plugin endpoint.
   Decision: **switchyard owns LLM data directly** here; the plugin
   contract is reserved for genuinely-external state (e.g. live n8n
   execution snapshots, autosavant-bot in-flight prompts). Cleaner split.
7. **Alerting.** PHASES.md §5.1 listed 5 alerts (HITL stalls, cycle-time
   regressions, API rate-limit hits, cost spikes, sandbox zombies).
   Recommendation: **defer to a second pass** — let the data exist for 2–4
   weeks, then build alerts on patterns we actually see, not patterns we
   imagine. Initial implementation surfaces HITL stalls as a UI tile
   (already in the sketch above), not a paging alert.
8. **`assignee=unassigned` mistakes vs. real ambient ops.** Some LLM
   calls genuinely have no ticket (the Scribe routing decision happens
   *before* a ticket exists). Distinguish via `ticket_id IS NULL` rather
   than a sentinel; UI groups these as "Ambient" in the cost leaderboard.

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

## Implementation skeleton (when this doc is approved)

1. **5.1.0 — Schema + endpoint.** `llm_observations` table, Drizzle
   migration, `model_pricing` table seeded with current Anthropic +
   Gemma + GPT prices, `POST /v1/llm-observations` route, `llm-obs:write`
   scope, Zod schemas, OpenAPI regen, integration test.
2. **5.1.1 — Emit-side wiring (imperium-loop).** Cogitation Engine n8n
   nodes, Servo-Signal per-turn hook, autosavant-bot prompt hook.
   Lives in `~/imperium-loop`, gated on 5.1.0 landing.
3. **5.1.2 — Switchyard Insights → LLM tab UI.** Six tiles per sketch
   above. Reads only; no mutation.
4. **5.1.3 — Aggregate + retention.** Daily rollup to
   `llm_observations_monthly_rollup`, 365d retention on raw, scheduled
   cleanup job.
5. **5.1.4 — (Deferred until data exists)** Alerts. Pattern-driven, not
   pre-imagined.

Phase 5.1 closes when 5.1.0 + 5.1.2 land with data flowing from at least
two emitters (Cogitation Engine planning + Servo-Signal greenfield). 5.1.1
finishes itself via imperium-loop's own tracker.
