# construct-server changes

These are the diffs to apply to `~/construct-server/` to deploy switchyard. Three files change. Apply them by hand — none are auto-applied.

## 1. `db/init-db.sh` — add the database

Add one line to the bottom of the existing script:

```sh
ensure_db switchyard_user "$SWITCHYARD_DB_PASSWORD" switchyard
```

Note: `init-db.sh` only runs when the `postgres_data` volume is empty (first-boot init). For an already-running Postgres instance, run the equivalent commands manually:

```bash
docker exec -i postgres psql -U postgres <<SQL
CREATE ROLE switchyard_user WITH LOGIN PASSWORD '$SWITCHYARD_DB_PASSWORD';
CREATE DATABASE switchyard OWNER switchyard_user;
GRANT ALL PRIVILEGES ON DATABASE switchyard TO switchyard_user;
SQL
```

## 2. `.env.example` (and your `.env`) — add new keys

Add to the end of `.env.example`:

```
# --- SWITCHYARD ---
SWITCHYARD_DB_PASSWORD=change_me
SWITCHYARD_PORT=4002
SWITCHYARD_PUBLIC_URL=http://localhost:4002
# Optional: prints a one-time bootstrap admin token in container logs on first boot
# if no api_tokens exist. Leave blank to auto-generate.
SWITCHYARD_BOOTSTRAP_TOKEN=
```

Mirror these keys (with real values) in `~/construct-server/.env`.

## 3. `docker-compose.yml` — add the service

Add this block alongside the other application services (e.g., near `cook_book` or `vikunja`):

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
      # Watchtower runs Mondays at 04:00 with rolling restart — opt out so deploys
      # are explicit. (Vikunja's password-drift bug is suspected to come from this.)
      - "com.centurylinklabs.watchtower.enable=false"
```

And add the volume to the `volumes:` block at the bottom:

```yaml
volumes:
  # ... existing volumes ...
  switchyard_uploads:
```

## 4. Optional: migrate Vikunja consumers later

The Imperium-Loop pipeline still points at Vikunja. Once switchyard is running, the migration is a separate task tracked in `~/imperium-loop/` — `tools/cogitation-patch/` will get a `swap-to-switchyard` subcommand that rewrites `http://vikunja:3456/api/v1` → `http://switchyard:4002/v1`, replaces the JWT login dance with a static bearer token, and adjusts payload shapes.

Don't delete Vikunja yet — run the two side-by-side until the cogitation engine is fully swapped over.

## Bring-up sequence

```bash
# 1. Add the env keys above to ~/construct-server/.env
# 2. Add the compose service + volume
# 3. From ~/construct-server:
make network                                  # idempotent if already created
docker compose up -d switchyard               # builds the image and starts the container
docker logs -f switchyard                     # watch migrations + startup
# Look for: "[migrate] done", "[switchyard] listening on :4002"
# If BOOTSTRAP_TOKEN was unset and api_tokens is empty, the bootstrap token
# is printed once. Copy it into n8n credentials, then revoke it after creating
# real per-user tokens.

# 4. Smoke test:
curl http://localhost:4002/healthz
# {"status":"ok","db":true}
```

## Sanity checks against existing patterns

These are how this service deviates (or doesn't) from `cook_book`, the closest sibling in `docker-compose.yml`:

| Concern | cook_book | switchyard |
|---|---|---|
| Builds locally | No (uses `image:`) | Yes (uses `build:`) |
| Watchtower | enabled (auto-update) | **disabled** |
| Postgres user | `cook_book_user` | `switchyard_user` |
| Migrations | Prisma at entrypoint | Drizzle + triggers.sql at entrypoint |
| Network | `construct_net` only | `construct_net` only |
| Volume | none | `switchyard_uploads` (attachments) |

The watchtower opt-out is the deliberate change. Updates happen via `git pull && docker compose up -d --build switchyard` instead of the surprise Monday rolling-restart.
