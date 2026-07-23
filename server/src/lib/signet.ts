// Signet connector client (SWY-165).
//
// A thin HTTP client for the Signet daemon's blind-mirror API (`signet serve`,
// ~/projects/signet). The routes in routes/signet.ts own auth/owner-gating and
// OpenAPI shape; this module owns the outbound call: config, bearer auth,
// timeout, `X-Signet-Actor` attribution, upstream-error relay, and validating
// the response against the shared Signet schemas before it crosses back.
//
// Config follows the cfAccessConfig() convention: presence of BOTH url + token
// is the enable switch, and the accessor returns null when disabled. The
// override hook lets tests toggle configured/not-configured without fighting
// env.ts (which parses once at import).

import type { z } from "zod";
import { env } from "../env.js";
import { serviceUnavailable, upstreamError } from "../errors.js";

export type SignetConfig = { baseUrl: string; token: string; timeoutMs: number };

// undefined = read from env; null or a value = explicit test override.
let configOverride: SignetConfig | null | undefined;

export function setSignetConfigForTests(cfg: SignetConfig | null | undefined): void {
  configOverride = cfg;
}

// Active config, or null when the connector is disabled (either env var unset).
export function signetConfig(): SignetConfig | null {
  if (configOverride !== undefined) return configOverride;
  if (!env.SIGNET_API_URL || !env.SIGNET_API_TOKEN) return null;
  return {
    baseUrl: env.SIGNET_API_URL.replace(/\/+$/, ""),
    token: env.SIGNET_API_TOKEN,
    timeoutMs: env.SIGNET_TIMEOUT_MS,
  };
}

// Single outbound call with the canonical AbortController timeout pattern
// (mirrors the webhook dispatcher). A network failure or timeout throws a 503
// serviceUnavailable — the daemon is host-resident and "unreachable" is the
// expected degraded state, not a bug.
async function signetFetch(
  cfg: SignetConfig,
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    return await fetch(`${cfg.baseUrl}${path}`, { method, signal: controller.signal, ...init });
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout after ${cfg.timeoutMs}ms`
          : err.message
        : String(err);
    throw serviceUnavailable(`Signet is unreachable: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch + relay upstream errors + validate against `schema`. A non-2xx is
// relayed via upstreamError carrying Signet's `{"error": ...}` message; a body
// that doesn't match the expected shape is a 503 (contract drift), not a 500.
async function requestJson<T>(
  cfg: SignetConfig,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const res = await signetFetch(cfg, method, path, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw serviceUnavailable("Signet returned a non-JSON response");
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : `responded ${res.status}`;
    throw upstreamError(res.status, `Signet: ${message}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw serviceUnavailable(
      `Signet returned an unexpected shape: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

export function signetGet<T>(cfg: SignetConfig, path: string, schema: z.ZodType<T>): Promise<T> {
  return requestJson(cfg, "GET", path, schema, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
}

// POST a command. `actor` is attributed in Signet's audit chain via
// X-Signet-Actor (the daemon prefixes it with "api:").
export function signetPost<T>(
  cfg: SignetConfig,
  path: string,
  body: unknown,
  actor: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return requestJson(cfg, "POST", path, schema, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
      ...(actor ? { "x-signet-actor": actor } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Liveness probe for GET /v1/signet/status. Hits the unauthenticated /healthz.
// Never throws — a failed probe is the reportable "not reachable" state.
export async function signetHealth(
  cfg: SignetConfig,
): Promise<{ reachable: boolean; version?: string; error?: string }> {
  try {
    const res = await signetFetch(cfg, "GET", "/healthz");
    if (!res.ok) return { reachable: false, error: `healthz responded ${res.status}` };
    const json = (await res.json().catch(() => ({}))) as { version?: unknown };
    return {
      reachable: true,
      ...(typeof json.version === "string" ? { version: json.version } : {}),
    };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
