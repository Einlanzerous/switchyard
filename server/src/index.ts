import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { assertDatabaseReachable, pingDatabase, shutdownDatabase } from "./db.js";
import { installErrorHandler } from "./errors.js";
import { mountRoutes } from "./routes/index.js";

await assertDatabaseReachable();

const app = new OpenAPIHono();

app.use("*", logger());
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

installErrorHandler(app);

// Health endpoint — checks DB connectivity. Returns 503 if DB is unreachable.
app.get("/healthz", async (c) => {
  const ok = await pingDatabase();
  return c.json({ status: ok ? "ok" : "degraded", db: ok }, ok ? 200 : 503);
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

// Static client — served from /app/client/dist in the production image.
// In dev, the client runs on Vite's dev server (port 5173) and proxies /v1 here,
// so this fallback only matters in production.
app.use("/*", serveStatic({ root: "./client-dist" }));
app.use("/*", serveStatic({ path: "./client-dist/index.html" }));

console.log(`[switchyard] listening on :${env.PORT}`);

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

const shutdown = async (signal: string) => {
  console.log(`[switchyard] received ${signal}, shutting down`);
  server.stop();
  await shutdownDatabase();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
