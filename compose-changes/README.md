# switchyard ↔ construct-server integration

Runbook for how switchyard plugs into the existing `~/construct-server` Docker stack. Most of this is already applied — keep this around for fresh installs, disaster recovery, and to explain why the integration looks the way it does.

## Where switchyard lives in the stack

- **Image:** built locally from `~/projects/switchyard/Dockerfile` (multi-stage Bun + Vue), not pulled from a registry.
- **Network:** `construct_net` only, alongside `postgres`, `n8n`, `servo-signal`, etc.
- **Database:** dedicated `switchyard` database on the shared Postgres 16 instance, owned by `switchyard_user`. A second `switchyard_test` database (same role) backs the integration test suite.
- **Storage:** named volume `switchyard_uploads` mounted at `/data/uploads` for attachment files. Postgres only stores `storage_path`.
- **Watchtower:** **opted out** via `com.centurylinklabs.watchtower.enable=false`. Updates happen via explicit `docker compose up -d --build switchyard`, not the Monday-04:00 rolling restart that's suspected of dropping Vikunja's DB password on a previous service.

## Database provisioning

`~/construct-server/db/init-db.sh` runs on first init of the `postgres_data` volume and provisions per-service databases. switchyard appends two `ensure_db` lines:

```sh
ensure_db switchyard_user "$SWITCHYARD_DB_PASSWORD" switchyard
ensure_db switchyard_user "$SWITCHYARD_DB_PASSWORD" switchyard_test
```

For an already-running Postgres (the common case — the volume's been around longer than switchyard), the equivalent one-time provisioning is:

```bash
docker exec -i postgres psql -U postgres <<SQL
CREATE ROLE switchyard_user WITH LOGIN PASSWORD '$SWITCHYARD_DB_PASSWORD';
CREATE DATABASE switchyard       OWNER switchyard_user;
CREATE DATABASE switchyard_test  OWNER switchyard_user;
GRANT ALL PRIVILEGES ON DATABASE switchyard       TO switchyard_user;
GRANT ALL PRIVILEGES ON DATABASE switchyard_test  TO switchyard_user;
SQL
```

## Environment variables

In `~/construct-server/.env` (and mirrored in `.env.example`):

```
# --- SWITCHYARD ---
SWITCHYARD_DB_PASSWORD=...
SWITCHYARD_PORT=4002
SWITCHYARD_PUBLIC_URL=http://localhost:4002
# Optional: registers an admin token attached to magos at boot. If unset and
# api_tokens is empty, a token is auto-generated and surfaced ONCE via stdout
# banner + ${UPLOAD_DIR}/.bootstrap-token (one-shot file).
SWITCHYARD_BOOTSTRAP_TOKEN=
```

## Compose service

The service block in `~/construct-server/docker-compose.yml`:

```yaml
  # --- TASK MANAGEMENT (switchyard — Vikunja replacement) ---
  switchyard:
    build:
      context: ../projects/switchyard
      dockerfile: Dockerfile
    container_name: switchyard
    restart: unless-stopped
    ports:
      - "${SWITCHYARD_PORT:-4002}:4002"
    environment:
      - PORT=4002
      - DATABASE_URL=postgres://switchyard_user:${SWITCHYARD_DB_PASSWORD}@postgres:5432/switchyard?sslmode=disable
      - PUBLIC_URL=${SWITCHYARD_PUBLIC_URL:-http://localhost:4002}
      - UPLOAD_DIR=/data/uploads
      - BOOTSTRAP_TOKEN=${SWITCHYARD_BOOTSTRAP_TOKEN}
    volumes:
      - switchyard_uploads:/data/uploads
    networks:
      - construct_net
    depends_on:
      - postgres
    labels:
      - "com.centurylinklabs.watchtower.enable=false"
```

…with `switchyard_uploads:` declared in the bottom-of-file `volumes:` block.

## How switchyard differs from `cook_book` (the closest sibling)

| Concern | cook_book | switchyard |
|---|---|---|
| Builds locally | No (uses `image:`) | Yes (uses `build:`) |
| Watchtower | enabled (auto-update) | **disabled** |
| Postgres user | `cook_book_user` | `switchyard_user` |
| Migrations | Prisma at entrypoint | Drizzle + `triggers.sql` + `seed.ts` at entrypoint |
| Network | `construct_net` only | `construct_net` only |
| Volume | none | `switchyard_uploads` (attachments) |

The watchtower opt-out is the deliberate divergence. switchyard exits non-zero on bad config / unreachable DB so docker reports the failure cleanly — the silent restart-loop into a broken state that bit Vikunja can't happen here.

## Bring-up (fresh install)

```bash
# From ~/construct-server, after the env vars and service block are in place:
make network                                  # idempotent
docker compose up -d --build switchyard       # builds image, starts container
docker logs -f switchyard                     # watch migrations + seed + dispatcher start

# Expected log sequence:
#   [migrate] running drizzle migrations
#   [migrate] applying triggers.sql
#   [migrate] running seed
#   [seed] created user: magos / claude / n8n-cogitation / ...
#   ═══ switchyard bootstrap token ═══   (one-shot banner if BOOTSTRAP_TOKEN env unset)
#   [dispatcher] started
#   [switchyard] listening on :4002

# Smoke test:
curl http://localhost:4002/healthz
# {"status":"ok","subsystems":{"db":{...},"uploads":{...},"webhooks":{...}}}
```

If `BOOTSTRAP_TOKEN` was unset and `api_tokens` was empty on first boot, the bootstrap token is also written to `/data/uploads/.bootstrap-token` inside the container — read it once with `docker exec switchyard cat /data/uploads/.bootstrap-token`, then mint real per-agent tokens via `POST /v1/users/{id}/tokens` and revoke the bootstrap.

## Updates

```bash
cd ~/projects/switchyard && git pull
cd ~/construct-server && docker compose up -d --build switchyard
```

Migrations are applied on every container start (idempotent). The seed routine is also idempotent — re-running it after canonical-user changes adds new agents without duplicating existing ones.

## Imperium-Loop migration (separate project)

The cogitation engine still points at Vikunja today. Migration belongs in `~/imperium-loop/`, not here — `tools/cogitation-patch/` is expected to gain a `swap-to-switchyard` subcommand that rewrites `http://vikunja:3456/api/v1` → `http://switchyard:4002/v1`, drops the per-run JWT login in favor of a static bearer token (stored in n8n credentials), and adjusts payload shapes (POST /comments instead of PUT, typed `/transition` endpoint instead of bucket-move).

Run switchyard side-by-side with Vikunja during the swap-over; only retire Vikunja once the cogitation engine has been fully retargeted.
