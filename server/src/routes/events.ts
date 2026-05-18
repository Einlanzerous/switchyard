import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { Event, EventType, ProjectKey, Iso8601, paginated, Pagination, Uuid } from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, z } from "./_helpers.js";
import { mapEvent } from "../lib/mappers.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { badRequest } from "../errors.js";
import { gte, lte } from "drizzle-orm";

const tag = "Events";

const list = createRoute({
  method: "get", path: "/v1/events", tags: [tag],
  summary: "Global event feed (audit log + chart source)",
  request: {
    query: Pagination.extend({
      project: ProjectKey.optional(),
      ticket_id: Uuid.optional(),
      actor_id: Uuid.optional(),
      event_type: z.string().optional(),
      since: Iso8601.optional(),
      until: Iso8601.optional(),
    }),
  },
  responses: { ...okJson(paginated(Event)), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/events/*", requireAuth);

  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [];

    if (q.project) {
      const [p] = await db.select({ id: schema.projects.id }).from(schema.projects)
        .where(eq(schema.projects.key, q.project)).limit(1);
      if (!p) {
        return c.json({ items: [], page: { next_cursor: null, has_more: false } }, 200);
      }
      conds.push(eq(schema.events.project_id, p.id));
    }

    if (q.ticket_id) conds.push(eq(schema.events.ticket_id, q.ticket_id));
    if (q.actor_id) conds.push(eq(schema.events.actor_id, q.actor_id));

    if (q.event_type) {
      const types = q.event_type.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (types.length === 1) conds.push(eq(schema.events.event_type, types[0]!));
      else if (types.length > 1) conds.push(inArray(schema.events.event_type, types));
    }

    if (q.since) conds.push(gte(schema.events.created_at, q.since));
    if (q.until) conds.push(lte(schema.events.created_at, q.until));

    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      // events are ordered by (created_at DESC, id DESC); cursor matches the
      // shape that buildPage/encodeCursor produces (k=created_at, i=id).
      // created_at is non-null by construction, so a null k means a
      // hand-crafted cursor — treat as invalid.
      if (!cur || cur.k === null) throw badRequest("invalid cursor");
      const k = cur.k;
      conds.push(or(
        lt(schema.events.created_at, k),
        and(eq(schema.events.created_at, k), lt(schema.events.id, cur.i))!,
      )!);
    }

    const rows = await db.select().from(schema.events)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(schema.events.created_at), desc(schema.events.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const items = (has_more ? rows.slice(0, limit) : rows).map(mapEvent);
    const last = has_more ? rows[limit - 1] : null;
    const next_cursor = last ? encodeCursor({ k: last.created_at, i: last.id }) : null;

    return c.json({ items, page: { next_cursor, has_more } }, 200);
  }) as any);
}
