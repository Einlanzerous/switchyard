// Structured access log middleware: one JSON line per request, written to stdout.
// Skipped on quiet paths (healthz + openapi doc) to keep `docker logs` legible.
//
// Each line carries:
//   ts            ISO timestamp at request end
//   request_id    inbound X-Request-ID header if present, else fresh UUID; echoed back
//   method        HTTP method
//   path          URL pathname
//   status        response code
//   duration_ms   server-side handler time
//   user_id       resolved auth.user.id (null if unauth)
//   token_id      resolved auth.token.id (null if unauth)

import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

const QUIET_PATHS = new Set(["/healthz", "/v1/openapi.json"]);

export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  const reqId = c.req.header("x-request-id") ?? randomUUID();
  c.header("X-Request-ID", reqId);

  await next();

  const path = new URL(c.req.url).pathname;
  if (QUIET_PATHS.has(path)) return;

  const duration_ms = Math.round(performance.now() - start);
  const auth = c.get("auth");

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    request_id: reqId,
    method: c.req.method,
    path,
    status: c.res.status,
    duration_ms,
    user_id: auth?.user?.id ?? null,
    token_id: auth?.token?.id ?? null,
  }));
};
