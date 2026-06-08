// Rules CRUD + firings log + redeliver.
//
// Scope model:
//   - GET endpoints: any authenticated user (mirrors webhooks)
//   - POST/PATCH/DELETE: rules:manage
//   - POST .../redeliver: rules:manage
//
// Idempotency middleware mounted same as webhooks/tickets. Cursor pagination
// uses (updated_at, id) for rules and (created_at, id) for firings.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  Rule, RuleWithSecret, CreateRule, UpdateRule, RuleFiring,
  Uuid, paginated, Pagination,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapRule, mapRuleWithSecret, mapRuleFiring } from "../lib/mappers.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { getProjectById } from "../lib/lookups.js";
import { generateWebhookSecret } from "../lib/id.js";
import { assertInstanceAdmin } from "../lib/authz.js";
import { badRequest, notFound } from "../errors.js";

const tag = "Rules";

const list = createRoute({
  method: "get", path: "/v1/rules", tags: [tag], summary: "List rules",
  request: { query: Pagination.extend({ project: z.string().optional() }) },
  responses: { ...okJson(paginated(Rule)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/rules", tags: [tag],
  summary: "Create a rule (webhook_secret returned ONCE)",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateRule } } },
  },
  responses: { ...createdJson(RuleWithSecret), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/rules/{id}", tags: [tag], summary: "Get a rule",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(Rule), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/rules/{id}", tags: [tag], summary: "Update a rule",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateRule } } },
  },
  responses: { ...okJson(Rule), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/rules/{id}", tags: [tag], summary: "Delete a rule",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const firings = createRoute({
  method: "get", path: "/v1/rules/{id}/firings", tags: [tag],
  summary: "Recent firings for a rule (debugging)",
  request: { params: z.object({ id: Uuid }), query: Pagination },
  responses: { ...okJson(paginated(RuleFiring)), ...errorResponses },
});

const redeliver = createRoute({
  method: "post", path: "/v1/rules/firings/{id}/redeliver", tags: [tag],
  summary: "Re-queue a rule firing (resets attempts and schedules immediately)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(RuleFiring), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/rules/*", requireAuth);
  app.use("/v1/rules/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "rules");
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [];

    if (q.project) {
      const [proj] = await db.select({ id: schema.projects.id })
        .from(schema.projects).where(eq(schema.projects.key, q.project)).limit(1);
      if (!proj) return c.json({ items: [], page: { next_cursor: null, has_more: false } }, 200);
      // Include global rules — they apply to every project, so they
      // belong in the answer when the caller asks "what rules affect KEY".
      conds.push(or(eq(schema.rules.project_id, proj.id), isNull(schema.rules.project_id))!);
    }

    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.rules.updated_at, schema.rules.id, cur));
    }

    const rows = await db.select().from(schema.rules)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...cursorOrderBy(schema.rules.updated_at, schema.rules.id))
      .limit(limit + 1);

    return c.json(buildPage(rows.map(mapRule), limit), 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "rules:manage");
    assertInstanceAdmin(c.get("auth").user, "rules");
    const body = c.req.valid("json");

    // Validate project exists + not deleted, but only when one is supplied.
    // null/missing project_id = global rule (Phase 4.1+).
    if (body.project_id) {
      await getProjectById(body.project_id);
    }

    // Always generate a webhook_secret at creation. Returned ONCE; cheap
    // to mint and lets users add fire_webhook/call_n8n actions later via
    // PATCH without recreating the rule.
    const webhook_secret = generateWebhookSecret();

    const [created] = await db.insert(schema.rules).values({
      project_id: body.project_id ?? null,
      name: body.name,
      enabled: body.enabled ?? true,
      // Default to empty array when scheduled (zod default already gives
      // []); shapes the row to match the DB CHECK.
      trigger_event_types: body.trigger_event_types ?? [],
      conditions: body.conditions as any,
      actions: body.actions as any,
      schedule_cron: body.schedule_cron ?? null,
      schedule_tz: body.schedule_tz ?? null,
      target_query: (body.target_query ?? null) as any,
      webhook_secret,
    }).returning();
    if (!created) throw new Error("rule insert returned nothing");

    return c.json(mapRuleWithSecret(created), 201);
  }) as any);

  // ─── get ─────────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "rules");
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.rules).where(eq(schema.rules.id, id)).limit(1);
    if (!row) throw notFound("rule");
    return c.json(mapRule(row), 200);
  }) as any);

  // ─── patch ───────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "rules:manage");
    assertInstanceAdmin(c.get("auth").user, "rules");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.rules).where(eq(schema.rules.id, id)).limit(1);
    if (!existing) throw notFound("rule");

    const sets: Partial<typeof schema.rules.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.enabled !== undefined) sets.enabled = body.enabled;
    if (body.trigger_event_types !== undefined) sets.trigger_event_types = body.trigger_event_types;
    if (body.conditions !== undefined) sets.conditions = body.conditions as any;
    if (body.actions !== undefined) sets.actions = body.actions as any;
    if (body.schedule_cron !== undefined) sets.schedule_cron = body.schedule_cron;
    if (body.schedule_tz !== undefined) sets.schedule_tz = body.schedule_tz;
    if (body.target_query !== undefined) sets.target_query = body.target_query as any;

    if (Object.keys(sets).length === 0) {
      return c.json(mapRule(existing), 200);
    }

    sets.updated_at = new Date().toISOString();
    const [updated] = await db.update(schema.rules).set(sets)
      .where(eq(schema.rules.id, id)).returning();
    if (!updated) throw notFound("rule");

    return c.json(mapRule(updated), 200);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "rules:manage");
    assertInstanceAdmin(c.get("auth").user, "rules");
    const { id } = c.req.valid("param");
    const result = await db.delete(schema.rules).where(eq(schema.rules.id, id))
      .returning({ id: schema.rules.id });
    if (result.length === 0) throw notFound("rule");
    return c.body(null, 204);
  }) as any);

  // ─── firings log ────────────────────────────────────────────────────────
  app.openapi(firings, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "rules");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const limit = q.limit;

    const [rule] = await db.select({ id: schema.rules.id })
      .from(schema.rules).where(eq(schema.rules.id, id)).limit(1);
    if (!rule) throw notFound("rule");

    const conds: SQL[] = [eq(schema.ruleFirings.rule_id, id)];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur || cur.k === null) throw badRequest("invalid cursor");
      conds.push(lt(schema.ruleFirings.created_at, cur.k));
    }

    const rows = await db.select().from(schema.ruleFirings)
      .where(and(...conds))
      .orderBy(desc(schema.ruleFirings.created_at), desc(schema.ruleFirings.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const slice = has_more ? rows.slice(0, limit) : rows;
    const items = slice.map(mapRuleFiring);
    const last = has_more ? slice[slice.length - 1] : null;
    const next_cursor = last ? encodeCursor({ k: last.created_at, i: last.id }) : null;
    return c.json({ items, page: { next_cursor, has_more } }, 200);
  }) as any);

  // ─── redeliver ──────────────────────────────────────────────────────────
  app.openapi(redeliver, (async (c: any) => {
    checkScope(c, "rules:manage");
    assertInstanceAdmin(c.get("auth").user, "rules");
    const { id } = c.req.valid("param");

    const [updated] = await db.update(schema.ruleFirings)
      .set({
        status: "pending",
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date().toISOString(),
        result_summary: null,
      })
      .where(eq(schema.ruleFirings.id, id))
      .returning();
    if (!updated) throw notFound("firing");

    return c.json(mapRuleFiring(updated), 200);
  }) as any);
}
