# syntax=docker/dockerfile:1.7

# ─── deps ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.1-alpine AS deps
WORKDIR /app

# Copy only manifests first — restores lockfile-aware caching.
COPY package.json bun.lock* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# bun install honors workspaces declared in the root package.json.
RUN bun install --frozen-lockfile || bun install

# ─── client build ──────────────────────────────────────────────────────────
FROM deps AS client-builder
WORKDIR /app
COPY shared ./shared
COPY client ./client
RUN bun --cwd client run build

# ─── runtime ───────────────────────────────────────────────────────────────
FROM oven/bun:1.1-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads

# wget is used by the HEALTHCHECK below.
RUN apk add --no-cache wget tini && \
    mkdir -p /data/uploads && \
    chown -R bun:bun /data

# Copy installed dependencies + source. We run TypeScript directly under bun,
# so there's no separate server bundle step.
COPY --from=client-builder /app/node_modules ./node_modules
COPY shared ./shared
COPY server ./server

# The client static bundle lands at /app/client-dist — server/src/index.ts
# serves from this path via Hono's serveStatic.
COPY --from=client-builder /app/client/dist ./client-dist

USER bun
EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT:-4002}/healthz" || exit 1

# Use tini as PID 1 so SIGTERM reaches the bun process cleanly.
ENTRYPOINT ["/sbin/tini", "--"]

# Migrations run on every container start; idempotent.
CMD ["sh", "-c", "bun /app/server/src/lib/migrate.ts && exec bun /app/server/src/index.ts"]
