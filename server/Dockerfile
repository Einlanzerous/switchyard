# syntax=docker/dockerfile:1.7

# ─── deps ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

COPY package.json bun.lock* ./
COPY tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY mcp/package.json ./mcp/

RUN bun install --frozen-lockfile || bun install

# ─── runtime ───────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads

RUN apk add --no-cache wget tini && \
    mkdir -p /data/uploads && \
    chown -R bun:bun /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY shared ./shared
COPY server ./server

USER bun
EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://localhost:${PORT:-4002}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "bun /app/server/src/lib/migrate.ts && exec bun /app/server/src/index.ts"]
