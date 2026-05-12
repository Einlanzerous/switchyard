// Named webhook targets (Phase 4.2.5). Decouples webhook endpoints
// from the rules/subscriptions that reference them so a service move
// is one PATCH instead of N edits.
//
// Scope: targets:manage for writes; reads are auth-only (mirrors
// rules/webhooks). DELETE rejects with 409 when any subscription or
// rule action still references the target — the response lists the
// dependent ids so the UI can prompt for explicit detach.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  Target, TargetWithSecret, CreateTarget, UpdateTarget,
  Uuid, paginated, Pagination,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { generateWebhookSecret } from "../lib/id.js";
import { badRequest, conflict, notFound, catchUnique } from "../errors.js";
import type {
  Target as ApiTarget, TargetWithSecret as ApiTargetWithSecret,
} from "@switchyard/shared";

const tag = "Targets";

type TargetRow = typeof schema.targets.$inferSelect;

function mapTarget(t: TargetRow): ApiTarget {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    url: t.url,
    headers: (t.headers ?? null) as Record<string, string> | null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function mapTargetWithSecret(t: TargetRow): ApiTargetWithSecret {
  return { ...mapTarget(t), hmac_secret: t.hmac_secret };
}

const list = createRoute({
  method: "get", path: "/v1/targets", tags: [tag], summary: "List targets",
  request: { query: Pagination },
  responses: { ...okJson(paginated(Target)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/targets", tags: [tag],
  summary: "Create a target (hmac_secret returned ONCE)",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateTarget } } },
  },
  responses: { ...createdJson(TargetWithSecret), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/targets/{id}", tags: [tag], summary: "Get a target",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(Target), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/targets/{id}", tags: [tag], summary: "Update a target",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateTarget } } },
  },
  responses: { ...okJson(Target), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/targets/{id}", tags: [tag],
  summary: "Delete a target (409 if referenced by subscriptions or rules)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/targets/*", requireAuth);
  app.use("/v1/targets/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [];

    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.targets.updated_at, schema.targets.id, cur));
    }

    const rows = await db.select().from(schema.targets)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...cursorOrderBy(schema.targets.updated_at, schema.targets.id))
      .limit(limit + 1);

    return c.json(buildPage(rows.map(mapTarget), limit), 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "targets:manage");
    const body = c.req.valid("json");

    // Normalize name to lowercase so case-only collisions (n8n vs N8N) are
    // caught by the unique index instead of producing two rows.
    const name = body.name.toLowerCase();

    // Three secret states:
    //   - undefined → generate one (default; HMAC always on)
    //   - null      → explicit "no signing for this target"
    //   - string    → caller-provided
    const hmac_secret =
      body.hmac_secret === undefined ? generateWebhookSecret() : body.hmac_secret;

    const [created] = await catchUnique("target name already exists", () =>
      db.insert(schema.targets).values({
        name,
        description: body.description ?? null,
        url: body.url,
        hmac_secret,
        headers: (body.headers ?? null) as any,
      }).returning()
    );
    if (!created) throw new Error("target insert returned nothing");

    return c.json(mapTargetWithSecret(created), 201);
  }) as any);

  // ─── get ─────────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.targets).where(eq(schema.targets.id, id)).limit(1);
    if (!row) throw notFound("target");
    return c.json(mapTarget(row), 200);
  }) as any);

  // ─── patch ───────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "targets:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.targets).where(eq(schema.targets.id, id)).limit(1);
    if (!existing) throw notFound("target");

    const sets: Partial<typeof schema.targets.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name.toLowerCase();
    if (body.description !== undefined) sets.description = body.description;
    if (body.url !== undefined) sets.url = body.url;
    if (body.hmac_secret !== undefined) sets.hmac_secret = body.hmac_secret;
    if (body.headers !== undefined) sets.headers = body.headers as any;

    if (Object.keys(sets).length === 0) return c.json(mapTarget(existing), 200);

    sets.updated_at = new Date().toISOString();
    const [updated] = await catchUnique("target name already exists", () =>
      db.update(schema.targets).set(sets).where(eq(schema.targets.id, id)).returning()
    );
    if (!updated) throw notFound("target");
    return c.json(mapTarget(updated), 200);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "targets:manage");
    const { id } = c.req.valid("param");

    const [existing] = await db.select().from(schema.targets).where(eq(schema.targets.id, id)).limit(1);
    if (!existing) throw notFound("target");

    // Two dependency surfaces:
    //   - webhook_subscriptions with target_id = this id
    //   - rules whose actions JSONB contains a fire_webhook with this
    //     target's name (or call_n8n when this target IS the n8n one)
    const subs = await db.select({ id: schema.webhookSubscriptions.id })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.target_id, id));

    // JSONB contains query: actions array has an element where target = name.
    // Postgres' @> is the cheapest path; index isn't needed at our scale.
    const ruleRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM rules
      WHERE actions @> ${JSON.stringify([{ target: existing.name }])}::jsonb
    ` as unknown as any) as unknown as Array<{ id: string }>;

    if (subs.length > 0 || ruleRows.length > 0) {
      throw conflict(
        `target "${existing.name}" is referenced by ${subs.length} subscription(s) and ${ruleRows.length} rule(s)`,
        {
          subscription_ids: subs.map((s) => s.id),
          rule_ids: ruleRows.map((r) => r.id),
        },
      );
    }

    const result = await db.delete(schema.targets).where(eq(schema.targets.id, id))
      .returning({ id: schema.targets.id });
    if (result.length === 0) throw notFound("target");
    return c.body(null, 204);
  }) as any);
}
