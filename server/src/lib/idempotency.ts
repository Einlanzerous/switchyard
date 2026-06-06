// Idempotency middleware.
//
// Honored on POST/PATCH/DELETE when an `Idempotency-Key` header is present.
// Scope: per (user_id, method, path, key). 24h TTL. Lazy expiration on lookup
// (no scheduled cleanup needed for correctness; we'll add one for hygiene).
//
// On replay, the original status + body is returned verbatim. We do NOT cache
// 5xx responses — those should be retried fresh.
//
// Behavior on missing auth: pass through. The auth middleware runs before this
// for protected routes, so by the time we get here `auth` is guaranteed to be
// set on those routes. For routes without auth, we'd skip caching anyway.

import type { MiddlewareHandler } from "hono";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "../db.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export const idempotency: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

  const key = c.req.header("idempotency-key");
  if (!key) return next();

  const auth = c.get("auth");
  if (!auth) return next();

  const path = new URL(c.req.url).pathname;
  const nowIso = new Date().toISOString();

  // Look up existing.
  const [cached] = await db
    .select()
    .from(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.user_id, auth.user.id),
        eq(schema.idempotencyKeys.method, method),
        eq(schema.idempotencyKeys.path, path),
        eq(schema.idempotencyKeys.key, key),
        gt(schema.idempotencyKeys.expires_at, nowIso)
      )
    )
    .limit(1);

  if (cached) {
    return c.json(cached.response_body as object, cached.response_status as any);
  }

  await next();

  // Capture response after handler runs. Skip caching for 5xx; clients should
  // retry those fresh.
  const status = c.res.status;
  if (status >= 500) return;

  let body: unknown = null;
  try {
    // c.res might already have been consumed; clone() makes the body re-readable.
    body = await c.res.clone().json();
  } catch {
    // Non-JSON response (file download, 204) — we can't replay it, so skip caching.
    return;
  }

  const expires = new Date(Date.now() + TTL_MS).toISOString();
  try {
    await db
      .insert(schema.idempotencyKeys)
      .values({
        key,
        user_id: auth.user.id,
        method,
        path,
        response_status: status,
        response_body: body as object,
        expires_at: expires,
      });
  } catch (err) {
    // Concurrent same-key request landed first — that's fine, the other one
    // wrote the cache entry. We just won't replay our own response next time.
  }
};

// Optional: hourly cleanup. Safe to call any time; deletes only expired rows.
// Wired into a setInterval at startup; not required for correctness.
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await db.execute<{ count: string }>(
    /* sql */ `DELETE FROM idempotency_keys WHERE expires_at <= now()` as unknown as any
  );
  return Number((result as any)?.count ?? 0);
}
