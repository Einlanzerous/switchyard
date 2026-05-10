import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { assertDatabaseReachable, shutdownDatabase } from "./db.js";
import { installErrorHandler } from "./errors.js";
import { mountRoutes } from "./routes/index.js";
import { startDispatcher, stopDispatcher } from "./lib/webhooks/dispatcher.js";
import { cleanupExpiredIdempotencyKeys } from "./lib/idempotency.js";
import { accessLog } from "./lib/access-log.js";
import { buildHealthReport } from "./lib/health.js";

await assertDatabaseReachable();

const app = new OpenAPIHono();

app.use("*", accessLog);
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"], exposeHeaders: ["X-Request-ID"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

installErrorHandler(app);

// Health endpoint — checks DB + uploads dir + webhook queue depth. Returns 503
// when any required subsystem is degraded so the orchestrator's healthcheck
// reflects reality.
app.get("/healthz", async (c) => {
  const report = await buildHealthReport();
  return c.json(report, report.status === "ok" ? 200 : 503);
});

// OpenAPI document & docs UI.
app.doc("/v1/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "switchyard",
    version: "0.0.0",
    description:
      "Self-hosted ticketing API. Agent-friendly: cursor pagination, idempotency keys, structured errors.",
  },
  servers: [{ url: env.PUBLIC_URL }],
});

mountRoutes(app);

// API-only — the static client lives in a sibling container that passthroughs
// /v1/* and /healthz here. Any unknown path is a JSON 404.
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  return c.json(
    { error: { code: "not_found" as const, message: `${c.req.method} ${path} not found` } },
    404
  );
});

console.log(`[switchyard] listening on :${env.PORT}`);

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

// Background workers.
startDispatcher();
const idempotencyCleanup = setInterval(
  () => void cleanupExpiredIdempotencyKeys().catch((e) => console.warn("[idempotency cleanup]", e)),
  60 * 60 * 1000
);

// Graceful shutdown: stop accepting new conns, let in-flight requests finish,
// drain the webhook dispatcher, then close the DB. Hard ceiling at 10s total.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[switchyard] received ${signal}, shutting down`);

  const deadline = Date.now() + 10_000;
  // Stop accepting new connections; in-flight requests may still complete.
  server.stop();
  clearInterval(idempotencyCleanup);

  const dispatcherBudget = Math.max(1_000, deadline - Date.now() - 1_000);
  await stopDispatcher(dispatcherBudget);
  await shutdownDatabase();

  console.log(`[switchyard] shutdown complete in ${Date.now() - (deadline - 10_000)}ms`);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
