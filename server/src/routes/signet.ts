// Signet connector proxy (SWY-165) — owner-only blind mirror of the Signet
// credential vault daemon (~/projects/signet).
//
// Every endpoint here forwards to the daemon's `signet serve` API and is gated
// to the instance OWNER only — agents are excluded even though they carry
// instance-wide access elsewhere, because the credential-vault mirror must not
// be driven by automation by default. Signet never returns plaintext values;
// only metadata, version hashes, sync state, and the audit chain cross this
// boundary (see shared/schemas/signet.ts).
//
// Degradation (the epic's feasibility constraint — no page ships against APIs
// that don't exist):
//   - not configured (SIGNET_API_URL/TOKEN unset) → data/command routes 503
//     `service_unavailable`; GET /status still answers 200 {configured:false}.
//   - configured but unreachable/timeout → 503; upstream non-2xx is relayed.
// The UI reads GET /status and renders "not connected" without calling the rest.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorEnvelope,
  SignetStatus, SignetSummary, SignetSecretsResponse, SignetSecretDetail,
  SignetAuditResponse, SignetSyncCommand, SignetAddTargetCommand,
  SignetSetExpiryCommand, SignetCommandResult,
} from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { assertInstanceOwner } from "../lib/authz.js";
import { serviceUnavailable } from "../errors.js";
import {
  signetConfig, signetHealth, signetGet, signetPost, type SignetConfig,
} from "../lib/signet.js";
import { errorResponses, okJson, z, idempotencyHeader } from "./_helpers.js";

const tag = "Signet";

// errorResponses has no 503; the connector needs one for its degraded states.
const signetErrorResponses = {
  ...errorResponses,
  503: { description: "signet not configured or unreachable", content: { "application/json": { schema: ErrorEnvelope } } },
} as const;

const status = createRoute({
  method: "get", path: "/v1/signet/status", tags: [tag],
  summary: "Signet connector status (configured + reachable)",
  responses: { ...okJson(SignetStatus), ...errorResponses },
});

const summary = createRoute({
  method: "get", path: "/v1/signet/summary", tags: [tag],
  summary: "Vault summary — counts + audit chain verification",
  responses: { ...okJson(SignetSummary), ...signetErrorResponses },
});

const secrets = createRoute({
  method: "get", path: "/v1/signet/secrets", tags: [tag],
  summary: "Blind secret registry, grouped by project",
  responses: { ...okJson(SignetSecretsResponse), ...signetErrorResponses },
});

const secretDetail = createRoute({
  method: "get", path: "/v1/signet/secrets/{project}/{name}", tags: [tag],
  summary: "One secret — blind view, targets, and its audit chain",
  request: { params: z.object({ project: z.string().min(1), name: z.string().min(1) }) },
  responses: { ...okJson(SignetSecretDetail), ...signetErrorResponses },
});

const audit = createRoute({
  method: "get", path: "/v1/signet/audit", tags: [tag],
  summary: "Newest audit-chain entries + verification",
  request: { query: z.object({ limit: z.coerce.number().int().positive().max(500).optional() }) },
  responses: { ...okJson(SignetAuditResponse), ...signetErrorResponses },
});

const cmdSync = createRoute({
  method: "post", path: "/v1/signet/commands/sync", tags: [tag],
  summary: "Seal & push a secret's GitHub Actions targets",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SignetSyncCommand } } },
  },
  responses: { ...okJson(SignetCommandResult), ...signetErrorResponses },
});

const cmdRotate = createRoute({
  method: "post", path: "/v1/signet/commands/rotate", tags: [tag],
  summary: "Rotate a generated secret, then fan out (409 if externally issued)",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SignetSyncCommand } } },
  },
  responses: { ...okJson(SignetCommandResult), ...signetErrorResponses },
});

const cmdAddTarget = createRoute({
  method: "post", path: "/v1/signet/commands/add-target", tags: [tag],
  summary: "Attach a GitHub Actions fan-out target to a secret",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SignetAddTargetCommand } } },
  },
  responses: { ...okJson(SignetCommandResult), ...signetErrorResponses },
});

const cmdSetExpiry = createRoute({
  method: "post", path: "/v1/signet/commands/set-expiry", tags: [tag],
  summary: "Set or clear a secret's expiry (empty string clears)",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SignetSetExpiryCommand } } },
  },
  responses: { ...okJson(SignetCommandResult), ...signetErrorResponses },
});

// Owner-gate + resolve config, or throw the degraded-state 503. Reads and
// commands both require the connector to be configured.
function requireSignet(c: any): SignetConfig {
  assertInstanceOwner(c.get("auth").user, "signet");
  const cfg = signetConfig();
  if (!cfg) throw serviceUnavailable("Signet is not configured");
  return cfg;
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/signet/*", requireAuth);
  app.use("/v1/signet/*", idempotency);

  // status — owner-gated, but answers even when not configured so the UI banner
  // has a single source of truth for connectivity.
  app.openapi(status, (async (c: any) => {
    assertInstanceOwner(c.get("auth").user, "signet");
    const cfg = signetConfig();
    if (!cfg) return c.json({ configured: false, reachable: false }, 200);
    const health = await signetHealth(cfg);
    return c.json(
      {
        configured: true,
        reachable: health.reachable,
        ...(health.version ? { version: health.version } : {}),
        ...(health.error ? { error: health.error } : {}),
      },
      200,
    );
  }) as any);

  app.openapi(summary, (async (c: any) => {
    const cfg = requireSignet(c);
    return c.json(await signetGet(cfg, "/v1/mirror/summary", SignetSummary), 200);
  }) as any);

  app.openapi(secrets, (async (c: any) => {
    const cfg = requireSignet(c);
    return c.json(await signetGet(cfg, "/v1/mirror/secrets", SignetSecretsResponse), 200);
  }) as any);

  app.openapi(secretDetail, (async (c: any) => {
    const cfg = requireSignet(c);
    const { project, name } = c.req.valid("param");
    const path = `/v1/mirror/secrets/${encodeURIComponent(project)}/${encodeURIComponent(name)}`;
    return c.json(await signetGet(cfg, path, SignetSecretDetail), 200);
  }) as any);

  app.openapi(audit, (async (c: any) => {
    const cfg = requireSignet(c);
    const { limit } = c.req.valid("query");
    const path = limit ? `/v1/mirror/audit?limit=${limit}` : "/v1/mirror/audit";
    return c.json(await signetGet(cfg, path, SignetAuditResponse), 200);
  }) as any);

  // Commands are issued to the daemon; the actor is attributed in Signet's
  // audit chain. Owner-gated only (via requireSignet) — no token scope, since an
  // owner UI session may not carry the `admin` scope (see SWY-169).
  const command = (upstreamPath: string) =>
    (async (c: any) => {
      const cfg = requireSignet(c);
      const actor = c.get("auth").user.name ?? "switchyard";
      const body = c.req.valid("json");
      return c.json(await signetPost(cfg, upstreamPath, body, actor, SignetCommandResult), 200);
    }) as any;

  app.openapi(cmdSync, command("/v1/commands/sync"));
  app.openapi(cmdRotate, command("/v1/commands/rotate"));
  app.openapi(cmdAddTarget, command("/v1/commands/add-target"));
  app.openapi(cmdSetExpiry, command("/v1/commands/set-expiry"));
}
