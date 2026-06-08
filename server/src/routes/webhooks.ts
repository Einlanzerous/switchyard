import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import {
  WebhookSubscription, WebhookSubscriptionWithSecret,
  CreateWebhookSubscription, UpdateWebhookSubscription,
  WebhookDelivery, Uuid, paginated, Pagination,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z } from "./_helpers.js";
import {
  mapWebhookSubscription, mapWebhookSubscriptionWithSecret, mapWebhookDelivery,
} from "../lib/mappers.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { generateWebhookSecret } from "../lib/id.js";
import { assertInstanceAdmin } from "../lib/authz.js";
import { badRequest, notFound } from "../errors.js";

const tag = "Webhooks";

const list = createRoute({
  method: "get", path: "/v1/webhooks", tags: [tag], summary: "List webhook subscriptions",
  request: { query: Pagination },
  responses: { ...okJson(paginated(WebhookSubscription)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/webhooks", tags: [tag],
  summary: "Create a webhook subscription (secret returned ONCE)",
  request: { body: { content: { "application/json": { schema: CreateWebhookSubscription } } } },
  responses: { ...createdJson(WebhookSubscriptionWithSecret), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/webhooks/{id}", tags: [tag], summary: "Get a webhook subscription",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(WebhookSubscription), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/webhooks/{id}", tags: [tag], summary: "Update a webhook subscription",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateWebhookSubscription } } },
  },
  responses: { ...okJson(WebhookSubscription), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/webhooks/{id}", tags: [tag], summary: "Delete a webhook subscription",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const deliveries = createRoute({
  method: "get", path: "/v1/webhooks/{id}/deliveries", tags: [tag],
  summary: "Recent delivery attempts for a subscription (debugging)",
  request: { params: z.object({ id: Uuid }), query: Pagination },
  responses: { ...okJson(paginated(WebhookDelivery)), ...errorResponses },
});

const redeliver = createRoute({
  method: "post", path: "/v1/webhooks/deliveries/{id}/redeliver", tags: [tag],
  summary: "Re-attempt a delivery (resets attempts and schedules immediately)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(WebhookDelivery), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/webhooks/*", requireAuth);
  app.use("/v1/webhooks/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "webhooks");
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.webhookSubscriptions.updated_at, schema.webhookSubscriptions.id, cur));
    }
    const rows = await db.select().from(schema.webhookSubscriptions)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...cursorOrderBy(schema.webhookSubscriptions.updated_at, schema.webhookSubscriptions.id))
      .limit(limit + 1);
    return c.json(buildPage(rows.map(mapWebhookSubscription), limit), 200);
  }) as any);

  // ─── create (mints secret, returned once) ────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "webhooks:manage");
    const body = c.req.valid("json");
    const secret = generateWebhookSecret();

    // If the caller attached a target, validate it exists so we fail
    // cleanly with 400 instead of writing an orphan row that confuses
    // the dispatcher's LEFT JOIN.
    if (body.target_id) {
      const [t] = await db.select({ id: schema.targets.id }).from(schema.targets)
        .where(eq(schema.targets.id, body.target_id)).limit(1);
      if (!t) throw badRequest(`target_id ${body.target_id} not found`);
    }

    const [created] = await db.insert(schema.webhookSubscriptions).values({
      url: body.url,
      event_types: body.event_types,
      status_filter: body.status_filter ?? null,
      secret,
      target_id: body.target_id ?? null,
      active: body.active ?? true,
    }).returning();
    if (!created) throw new Error("insert returned nothing");

    return c.json(mapWebhookSubscriptionWithSecret(created), 201);
  }) as any);

  // ─── get ─────────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "webhooks");
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id)).limit(1);
    if (!row) throw notFound("webhook subscription");
    return c.json(mapWebhookSubscription(row), 200);
  }) as any);

  // ─── patch ───────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "webhooks:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id)).limit(1);
    if (!existing) throw notFound("webhook subscription");

    const sets: Partial<typeof schema.webhookSubscriptions.$inferInsert> = {};
    if (body.url !== undefined) sets.url = body.url;
    if (body.event_types !== undefined) sets.event_types = body.event_types;
    if (body.status_filter !== undefined) sets.status_filter = body.status_filter ?? null;
    if (body.active !== undefined) sets.active = body.active;
    if (body.target_id !== undefined) {
      // null detaches; a uuid attaches (validate it exists).
      if (body.target_id !== null) {
        const [t] = await db.select({ id: schema.targets.id }).from(schema.targets)
          .where(eq(schema.targets.id, body.target_id)).limit(1);
        if (!t) throw badRequest(`target_id ${body.target_id} not found`);
      }
      sets.target_id = body.target_id;
    }

    if (Object.keys(sets).length === 0) {
      return c.json(mapWebhookSubscription(existing), 200);
    }

    const [updated] = await db.update(schema.webhookSubscriptions)
      .set(sets)
      .where(eq(schema.webhookSubscriptions.id, id))
      .returning();
    if (!updated) throw notFound("webhook subscription");

    return c.json(mapWebhookSubscription(updated), 200);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "webhooks:manage");
    const { id } = c.req.valid("param");
    const result = await db.delete(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id))
      .returning({ id: schema.webhookSubscriptions.id });
    if (result.length === 0) throw notFound("webhook subscription");
    return c.body(null, 204);
  }) as any);

  // ─── deliveries log ─────────────────────────────────────────────────────
  app.openapi(deliveries, (async (c: any) => {
    assertInstanceAdmin(c.get("auth").user, "webhooks");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const limit = q.limit;

    const [sub] = await db.select({ id: schema.webhookSubscriptions.id })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id)).limit(1);
    if (!sub) throw notFound("webhook subscription");

    // Deliveries don't have updated_at; cursor uses (created_at, id).
    const conds: SQL[] = [eq(schema.webhookDeliveries.subscription_id, id)];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur || cur.k === null) throw badRequest("invalid cursor");
      const k = cur.k;
      conds.push(or(
        lt(schema.webhookDeliveries.created_at, k),
        and(
          eq(schema.webhookDeliveries.created_at, k),
          lt(schema.webhookDeliveries.id, cur.i),
        )!,
      )!);
    }

    const rows = await db.select().from(schema.webhookDeliveries)
      .where(and(...conds))
      .orderBy(desc(schema.webhookDeliveries.created_at), desc(schema.webhookDeliveries.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const slice = has_more ? rows.slice(0, limit) : rows;
    const items = slice.map(mapWebhookDelivery);
    const last = has_more ? slice[slice.length - 1] : null;
    const next_cursor = last ? encodeCursor({ k: last.created_at, i: last.id }) : null;

    return c.json({ items, page: { next_cursor, has_more } }, 200);
  }) as any);

  // ─── redeliver ───────────────────────────────────────────────────────────
  app.openapi(redeliver, (async (c: any) => {
    checkScope(c, "webhooks:manage");
    const { id } = c.req.valid("param");

    const [updated] = await db.update(schema.webhookDeliveries)
      .set({
        status: "pending",
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date().toISOString(),
      })
      .where(eq(schema.webhookDeliveries.id, id))
      .returning();
    if (!updated) throw notFound("delivery");

    return c.json(mapWebhookDelivery(updated), 200);
  }) as any);
}
