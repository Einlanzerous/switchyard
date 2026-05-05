import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "@switchyard/shared";
import type { ApiTokenScope } from "@switchyard/shared";
import { notImplemented, unauthorized, forbidden } from "../errors.js";
import { requireScope as _requireScope } from "../auth.js";

// All non-2xx responses use the same envelope. Centralized so route definitions
// don't have to repeat the response shape.
export const errorResponses = {
  400: { description: "bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  401: { description: "unauthorized", content: { "application/json": { schema: ErrorEnvelope } } },
  403: { description: "forbidden", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "not found", content: { "application/json": { schema: ErrorEnvelope } } },
  409: { description: "conflict", content: { "application/json": { schema: ErrorEnvelope } } },
  422: { description: "unprocessable", content: { "application/json": { schema: ErrorEnvelope } } },
  500: { description: "internal", content: { "application/json": { schema: ErrorEnvelope } } },
} as const;

export const okJson = <T extends z.ZodTypeAny>(schema: T, description = "ok") => ({
  200: { description, content: { "application/json": { schema } } },
});

export const createdJson = <T extends z.ZodTypeAny>(schema: T) => ({
  201: { description: "created", content: { "application/json": { schema } } },
});

export const noContent = {
  204: { description: "no content" },
} as const;

// Stub handler — every route in Phase 0 returns 501. Phase 1 replaces these
// one-by-one with real implementations.
export const stub: any = () => {
  throw notImplemented();
};

// Loosely-typed wrapper around requireScope. @hono/zod-openapi's `app.openapi`
// types every subsequent argument as a Handler with a TypedResponse return,
// which a generic MiddlewareHandler doesn't satisfy. Casting to `any` here
// keeps route definitions readable without poisoning the whole auth module.
export const scope = (...scopes: ApiTokenScope[]): any => _requireScope(...scopes);

// Common header schemas.
export const idempotencyHeader = z.object({
  "idempotency-key": z.string().min(1).max(128).optional(),
});

export { z };

/**
 * Throwing version of scope check for use inside handlers.
 */
export function checkScope(c: any, ...scopes: ApiTokenScope[]) {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  const granted = auth.token.scopes as ApiTokenScope[];
  if (granted.includes("admin")) return;
  const ok = scopes.every((s) => granted.includes(s));
  if (!ok) throw forbidden(`requires scope(s): ${scopes.join(", ")}`);
}
