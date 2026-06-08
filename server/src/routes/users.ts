import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  User, CreateUser, UpdateUser, Uuid,
  ApiToken, CreateApiToken, ApiTokenWithSecret, paginated, Pagination,
  NotificationsPage, ListNotificationsQuery, MarkReadInput, UnreadCount,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, z, checkScope } from "./_helpers.js";
import { mapUser, mapApiToken, mapTicketSummary } from "../lib/mappers.js";
import { getUserById } from "../lib/lookups.js";
import { visibleUserIds } from "../lib/authz.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { generateApiToken } from "../lib/id.js";
import { badRequest, catchUnique, notFound } from "../errors.js";

const tag = "Users";

const list = createRoute({
  method: "get", path: "/v1/users", tags: [tag], summary: "List users",
  request: { query: Pagination },
  responses: { ...okJson(paginated(User)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/users", tags: [tag], summary: "Create a user",
  request: { body: { content: { "application/json": { schema: CreateUser } } } },
  responses: { ...createdJson(User), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/users/{id}", tags: [tag], summary: "Get a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(User), ...errorResponses },
});

const me = createRoute({
  method: "get", path: "/v1/users/me", tags: [tag], summary: "Get the user owning the current token",
  responses: { ...okJson(User), ...errorResponses },
});

const myNotifications = createRoute({
  method: "get", path: "/v1/users/me/notifications", tags: [tag],
  summary: "Persistent notifications (mentions today; more kinds later)",
  request: { query: ListNotificationsQuery },
  responses: { ...okJson(NotificationsPage), ...errorResponses },
});

const markNotificationsRead = createRoute({
  method: "post", path: "/v1/users/me/notifications/mark-read", tags: [tag],
  summary: "Mark a set of notifications (or all) as read",
  request: { body: { content: { "application/json": { schema: MarkReadInput } } } },
  responses: { ...okJson(UnreadCount), ...errorResponses },
});

const myUnreadCount = createRoute({
  method: "get", path: "/v1/users/me/notifications/unread-count", tags: [tag],
  summary: "Cheap unread-count for the topbar bell",
  responses: { ...okJson(UnreadCount), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/users/{id}", tags: [tag], summary: "Update a user",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateUser } } },
  },
  responses: { ...okJson(User), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/users/{id}", tags: [tag], summary: "Soft-delete a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const listTokens = createRoute({
  method: "get", path: "/v1/users/{id}/tokens", tags: [tag], summary: "List API tokens for a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(z.object({ items: z.array(ApiToken) })), ...errorResponses },
});

const createToken = createRoute({
  method: "post", path: "/v1/users/{id}/tokens", tags: [tag],
  summary: "Create a new API token (plaintext returned ONCE)",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: CreateApiToken } } },
  },
  responses: { ...createdJson(ApiTokenWithSecret), ...errorResponses },
});

const revokeToken = createRoute({
  method: "delete", path: "/v1/users/{id}/tokens/{tokenId}", tags: [tag], summary: "Revoke an API token",
  request: { params: z.object({ id: Uuid, tokenId: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/users/*", requireAuth);
  app.use("/v1/users/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [isNull(schema.users.deleted_at)];
    // 6.1.5 directory policy: a member sees only co-members of their projects
    // (∪ agents ∪ self); owner/agent see the full roster (null = no filter).
    const visible = await visibleUserIds(c.get("auth").user);
    if (visible) conds.push(inArray(schema.users.id, [...visible]));
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.users.updated_at, schema.users.id, cur));
    }
    const rows = await db.select().from(schema.users)
      .where(and(...conds))
      .orderBy(...cursorOrderBy(schema.users.updated_at, schema.users.id))
      .limit(limit + 1);
    return c.json(buildPage(rows.map(mapUser), limit), 200);
  }) as any);

  app.openapi(me, (async (c: any) => {
    const auth = c.get("auth");
    return c.json(mapUser(auth.user), 200);
  }) as any);

  // The 3.1 live-scan /v1/users/me/mentions endpoint was removed in 3.4.
  // Notifications now persist via the comment / description-edit hooks
  // and are served by /v1/users/me/notifications below.

  // ─── /v1/users/me/notifications ─────────────────────────────────────────
  //
  // Persistent backing for @mentions. Reads from the notifications table
  // populated synchronously inside the comment / ticket-description write
  // handlers. List handler joins back to ticket summaries so the client
  // can render type icons / titles without a follow-up fetch.

  app.openapi(myNotifications, (async (c: any) => {
    const auth = c.get("auth");
    const me = auth.user as typeof schema.users.$inferSelect;
    const q = c.req.valid("query");
    const limit = q.limit;

    const conds: SQL[] = [eq(schema.notifications.user_id, me.id)];
    if (q.status === "unread") conds.push(isNull(schema.notifications.read_at));
    if (q.since) conds.push(gte(schema.notifications.created_at, q.since));
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(or(
        sql`${schema.notifications.created_at} < ${cur.k}`,
        sql`(${schema.notifications.created_at} = ${cur.k} AND ${schema.notifications.id} < ${cur.i})`
      )!);
    }

    const rows = await db
      .select()
      .from(schema.notifications)
      .where(and(...conds))
      .orderBy(desc(schema.notifications.created_at), desc(schema.notifications.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const trimmed = has_more ? rows.slice(0, limit) : rows;

    // Hydrate ticket summaries in batch, same shape the /mentions endpoint
    // produces. Tickets that have been hard-deleted are dropped (the
    // notification stays in the table but the row is filtered from the
    // response).
    const ticketIds = [...new Set(trimmed.map((n) => n.ticket_id).filter((x): x is string => !!x))];
    const ticketRows = ticketIds.length > 0
      ? await db.select().from(schema.tickets).where(inArray(schema.tickets.id, ticketIds))
      : [];
    const ticketById = new Map(ticketRows.map((t) => [t.id, t]));

    const projectIds = [...new Set(ticketRows.map((t) => t.project_id))];
    const statusIds = [...new Set(ticketRows.map((t) => t.status_id))];
    const userIds = [...new Set([
      ...trimmed.map((n) => n.actor_id).filter((x): x is string => !!x),
      ...ticketRows.flatMap((t) => [t.assignee_id, t.reporter_id]).filter((x): x is string => !!x),
    ])];

    const [projectRows, statusRows, userRows, labelRows] = await Promise.all([
      projectIds.length > 0
        ? db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds))
        : Promise.resolve([]),
      statusIds.length > 0
        ? db.select().from(schema.statuses).where(inArray(schema.statuses.id, statusIds))
        : Promise.resolve([]),
      userIds.length > 0
        ? db.select().from(schema.users).where(inArray(schema.users.id, userIds))
        : Promise.resolve([]),
      ticketIds.length > 0
        ? db.select({ ticket_id: schema.ticketLabels.ticket_id, label: schema.labels })
            .from(schema.ticketLabels)
            .innerJoin(schema.labels, eq(schema.ticketLabels.label_id, schema.labels.id))
            .where(inArray(schema.ticketLabels.ticket_id, ticketIds))
        : Promise.resolve([]),
    ]);
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const statusById = new Map(statusRows.map((s) => [s.id, s]));
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const labelsByTicket = new Map<string, typeof schema.labels.$inferSelect[]>();
    for (const lr of labelRows) {
      const list = labelsByTicket.get(lr.ticket_id) ?? [];
      list.push(lr.label);
      labelsByTicket.set(lr.ticket_id, list);
    }

    const items = trimmed.map((n) => {
      const ticket = n.ticket_id ? ticketById.get(n.ticket_id) ?? null : null;
      const summary = (() => {
        if (!ticket) return null;
        const project = projectById.get(ticket.project_id);
        const status = statusById.get(ticket.status_id);
        const reporter = userById.get(ticket.reporter_id);
        if (!project || !status || !reporter) return null;
        const assignee = ticket.assignee_id ? userById.get(ticket.assignee_id) ?? null : null;
        return mapTicketSummary(ticket, {
          project, status, assignee, reporter,
          labels: labelsByTicket.get(ticket.id) ?? [],
          number: ticket.number,
          // Notifications dropdown context — refs not needed here; skip
          // the fan-out so this stays a cheap render.
          externalRefs: [],
        });
      })();
      const actor = n.actor_id ? userById.get(n.actor_id) ?? null : null;
      return {
        id: n.id,
        kind: n.kind,
        actor: actor ? { id: actor.id, name: actor.name, icon: actor.icon, type: actor.type } : null,
        ticket: summary,
        comment_id: n.comment_id,
        payload: (n.payload ?? {}) as { source: "comment" | "description"; snippet: string; actor?: any },
        read_at: n.read_at,
        created_at: n.created_at,
      };
    });

    const last = has_more ? trimmed[trimmed.length - 1] : null;
    const next_cursor = last ? encodeCursor({ k: last.created_at, i: last.id }) : null;
    return c.json({ items, page: { next_cursor, has_more } }, 200);
  }) as any);

  app.openapi(markNotificationsRead, (async (c: any) => {
    const auth = c.get("auth");
    const me = auth.user as typeof schema.users.$inferSelect;
    const body = c.req.valid("json");
    const nowIso = new Date().toISOString();

    if ("all" in body && body.all) {
      await db.update(schema.notifications)
        .set({ read_at: nowIso })
        .where(and(
          eq(schema.notifications.user_id, me.id),
          isNull(schema.notifications.read_at)
        ));
    } else if ("ids" in body && Array.isArray(body.ids) && body.ids.length > 0) {
      await db.update(schema.notifications)
        .set({ read_at: nowIso })
        .where(and(
          eq(schema.notifications.user_id, me.id),
          inArray(schema.notifications.id, body.ids),
          isNull(schema.notifications.read_at)
        ));
    }

    const [row] = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM notifications
          WHERE user_id = ${me.id} AND read_at IS NULL` as any
    ) as unknown as Array<{ count: number }>;
    const r = (row as any) ?? ((await db.execute(sql`SELECT 0::int AS count`)) as any).rows?.[0];
    return c.json({ count: r?.count ?? 0 }, 200);
  }) as any);

  app.openapi(myUnreadCount, (async (c: any) => {
    const auth = c.get("auth");
    const me = auth.user as typeof schema.users.$inferSelect;
    const result = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM notifications
          WHERE user_id = ${me.id} AND read_at IS NULL` as any
    ) as unknown as Array<{ count: number }>;
    const row = (result as any).rows ? (result as any).rows[0] : (result as any)[0];
    return c.json({ count: row?.count ?? 0 }, 200);
  }) as any);

  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const u = await getUserById(id);
    // 6.1.5: a member can only resolve users inside their directory (co-members
    // ∪ agents ∪ self). 404 (not 403) for anyone outside it — a member can't
    // probe the roster by enumerating ids. Owner/agent (null) see everyone.
    const visible = await visibleUserIds(c.get("auth").user);
    if (visible && !visible.has(id)) throw notFound("user");
    return c.json(mapUser(u), 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "users:manage");
    const body = c.req.valid("json");
    const [created] = await catchUnique(`user "${body.name}" already exists`, () =>
      db.insert(schema.users).values({
        name: body.name,
        type: body.type,
        icon: body.icon ?? null,
      }).returning()
    );
    if (!created) throw new Error("insert returned nothing");
    return c.json(mapUser(created), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await getUserById(id);

    const sets: Partial<typeof schema.users.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.type !== undefined) sets.type = body.type;
    if (body.icon !== undefined) sets.icon = body.icon ?? null;

    if (Object.keys(sets).length === 0) {
      const u = await getUserById(id);
      return c.json(mapUser(u), 200);
    }

    const [updated] = await catchUnique("name already in use", () =>
      db.update(schema.users)
        .set(sets)
        .where(eq(schema.users.id, id))
        .returning()
    );
    if (!updated) throw notFound("user");
    return c.json(mapUser(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    await getUserById(id);
    await db.update(schema.users)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(schema.users.id, id));
    return c.body(null, 204);
  }) as any);

  app.openapi(listTokens, (async (c: any) => {
    // Token metadata is admin-only — mirrors createToken / revokeToken below.
    // (Was missing a scope check before 6.1.5; closed in the admin-surface audit.)
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    await getUserById(id);
    const rows = await db.select().from(schema.apiTokens)
      .where(eq(schema.apiTokens.user_id, id))
      .orderBy(desc(schema.apiTokens.created_at));
    return c.json({ items: rows.map(mapApiToken) }, 200);
  }) as any);

  app.openapi(createToken, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await getUserById(id);

    const { token, hash, prefix } = generateApiToken();
    const [created] = await db.insert(schema.apiTokens).values({
      user_id: id,
      name: body.name,
      hashed_token: hash,
      token_prefix: prefix,
      scopes: body.scopes,
    }).returning();
    if (!created) throw new Error("insert returned nothing");

    return c.json({ ...mapApiToken(created), token }, 201);
  }) as any);

  app.openapi(revokeToken, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id, tokenId } = c.req.valid("param");
    const [updated] = await db.update(schema.apiTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.user_id, id),
      ))
      .returning();
    if (!updated) throw notFound("token");
    return c.body(null, 204);
  }) as any);
}
