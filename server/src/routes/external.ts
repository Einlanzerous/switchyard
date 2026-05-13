// External-service webhook receivers. Currently just GitHub; GitLab /
// Bitbucket would follow the same shape if asked for.
//
// Auth model differs from the rest of the API: callers are GitHub's
// servers (no bearer token), and the HMAC signature is the auth.
// `requireAuth` is intentionally NOT mounted on this path.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { verifyHmac } from "../lib/hmac.js";
import { handlePullRequestEvent } from "../lib/externalRefs/githubWebhook.js";
import { errorResponses, okJson, z } from "./_helpers.js";

const tag = "External";

// GitHub webhooks aren't represented in the typed body — payload shape
// depends on the event, and we only consume a few fields. We accept
// anything and verify by HMAC before parsing.
const GenericResponse = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  updated: z.number().int().nonnegative().optional(),
});

const github = createRoute({
  method: "post", path: "/v1/external/github", tags: [tag],
  summary: "GitHub webhook receiver (HMAC-verified; not bearer-token auth)",
  request: {
    body: { content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
  responses: { ...okJson(GenericResponse), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(github, (async (c: any) => {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      return c.json({ ok: false, message: "GitHub webhook receiver not configured" }, 503);
    }

    // We need the raw body bytes for the HMAC check — Hono's
    // c.req.json() reparses, which is fine, but the signature is
    // computed against the original payload string.
    const rawBody = await c.req.text();
    const sig = c.req.header("x-hub-signature-256") ?? "";
    if (!sig || !verifyHmac(env.GITHUB_WEBHOOK_SECRET, rawBody, sig)) {
      // GitHub will retry on 4xx for some events; 401 specifically
      // signals "drop this delivery, don't retry."
      return c.json(
        { error: { code: "unauthorized" as const, message: "invalid X-Hub-Signature-256" } },
        401,
      );
    }

    const event = c.req.header("x-github-event") ?? "";
    if (event === "ping") {
      // GitHub sends `ping` on subscription creation. Acknowledge so
      // the webhook setup UI shows green.
      return c.json({ ok: true, message: "pong" }, 200);
    }

    if (event !== "pull_request") {
      // Quiet 200 for events we don't care about so GitHub doesn't
      // retry them. Future-room: check_run / workflow_run handlers.
      return c.json({ ok: true, message: `event ${event} ignored` }, 200);
    }

    let payload: { action?: string; pull_request?: unknown };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json(
        { error: { code: "bad_request" as const, message: "malformed JSON body" } },
        400,
      );
    }

    if (!payload.action || !payload.pull_request) {
      return c.json({ ok: true, message: "malformed pull_request payload, ignored" }, 200);
    }

    // Resolve the rules-engine user id for the audit actor. Cached
    // once at process start would be nicer; this is a webhook hot
    // path so the lookup adds one query per delivery — acceptable.
    const [rulesEngine] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.name, "rules-engine")).limit(1);
    if (!rulesEngine) {
      return c.json(
        { error: { code: "internal" as const, message: "rules-engine user not seeded" } },
        500,
      );
    }

    const updated = await handlePullRequestEvent(
      payload as any,
      { keyPrefix: env.EXTERNAL_REF_KEY_PREFIX, rulesEngineUserId: rulesEngine.id },
    );
    return c.json({ ok: true, updated }, 200);
  }) as any);
}
