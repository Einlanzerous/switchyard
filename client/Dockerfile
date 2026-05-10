# syntax=docker/dockerfile:1.7

# ─── builder ───────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

COPY package.json bun.lock* ./
COPY tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN bun install --frozen-lockfile || bun install

COPY shared ./shared
COPY client ./client
RUN bun run --cwd client build

# ─── runtime ───────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache wget tini

COPY --from=builder /app/client/dist ./dist
COPY client/serve.ts ./serve.ts

EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://localhost:${PORT:-4002}/" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "/app/serve.ts"]
