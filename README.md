# switchyard

Self-hosted ticketing / project-management system. API-first, agent-first. Replaces Vikunja in the Imperium-Loop pipeline.

## Stack

- **Server:** Hono on Bun, Drizzle ORM, Zod schemas (single source of truth for validation + OpenAPI + shared types).
- **Client:** Vue 3 + Vite + TypeScript + Tailwind + shadcn-vue + Pinia + TanStack Query.
- **Database:** PostgreSQL 16 (shared instance on `construct_net`).
- **Deploy:** Single container — Hono serves the API at `/v1/*` and the built Vue client at `/`.

## Layout

```
switchyard/
├── server/             Hono + Drizzle backend
├── client/             Vue 3 frontend
├── shared/             Zod schemas + derived TS types (consumed by both)
├── compose-changes/    Proposed diffs for ~/construct-server
├── Dockerfile          Multi-stage build
└── openapi.yaml        Generated from server route definitions
```

## Development

```bash
bun install
bun run db:generate    # generate Drizzle migrations from schema changes
bun run db:migrate     # apply migrations to $DATABASE_URL
bun run dev:server     # API on :4002
bun run dev:client     # Vite dev server on :5173, proxies /v1 to :4002
bun run openapi:gen    # writes openapi.yaml from current route definitions
```

## Roadmap

Full phased plan + architectural decisions in [`PHASES.md`](./PHASES.md).

## Phase 0 — what's here

This commit lays the contract:

- Drizzle schema (`server/drizzle/schema.ts`) for all tables.
- Zod schemas (`shared/src/schemas/*.ts`) for every resource.
- Hono route definitions with `@hono/zod-openapi` (`server/src/routes/*.ts`) — handlers return 501 Not Implemented; only the contract is wired.
- Health check endpoint with real DB ping.
- Auth middleware skeleton (bearer token check against `api_tokens`).
- Multi-stage Dockerfile.
- Compose / init-db / env diffs for `~/construct-server` in `compose-changes/`.

Phase 1 (next) implements the handlers, webhook fan-out, and idempotency keys.

## Deployment notes

- Reads `DATABASE_URL` once at startup; if Postgres is unreachable, the process exits non-zero so Docker reports the failure cleanly (no silent restart-loop into a broken state).
- Watchtower is opted out via `com.centurylinklabs.watchtower.enable=false` — updates happen via deploys, not surprise restarts.
- Attachment files live in a named volume mounted at `/data/uploads`; database stores `storage_path` only.

## Webhook payload shape

All outbound webhooks share one envelope:

```json
{
  "id": "evt_<uuid>",
  "event": "ticket.status_changed",
  "occurred_at": "2026-05-02T15:04:05Z",
  "actor": { "id": "<uuid>", "name": "magos", "type": "human" },
  "ticket": { ... full embedded ticket ... },
  "changes": { "status": { "from": {...}, "to": {...} } }
}
```

HMAC signature in `X-Switchyard-Signature: sha256=<hex>` (HMAC-SHA256 of body with the subscription's secret). Event type also in `X-Switchyard-Event` for routing without body parsing.
