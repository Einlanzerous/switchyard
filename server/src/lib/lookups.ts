// Resolve identifiers used in URL paths and query params.
// Kept centralized so 404 messages stay consistent and shape-checks live in one place.

import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import { notFound, badRequest } from "../errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_KEY_RE = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/;

// Resolve a path param that may be either a UUID or a project-prefixed ticket
// key (`SWY-47`). Returns the row or throws notFound.
export async function resolveTicket(idOrKey: string, opts: { includeDeleted?: boolean } = {}) {
  const includeDeleted = opts.includeDeleted ?? false;

  // Path 1: UUID
  if (UUID_RE.test(idOrKey)) {
    const conds = [eq(schema.tickets.id, idOrKey)];
    if (!includeDeleted) conds.push(isNull(schema.tickets.deleted_at));
    const [row] = await db.select().from(schema.tickets).where(and(...conds)).limit(1);
    if (!row) throw notFound("ticket");
    return row;
  }

  // Path 2: KEY-NUM
  const m = TICKET_KEY_RE.exec(idOrKey);
  if (!m) throw badRequest(`invalid ticket id or key: ${idOrKey}`);
  const projectKey = m[1]!;
  const number = Number(m[2]);

  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.key, projectKey), isNull(schema.projects.deleted_at)))
    .limit(1);
  if (!project) throw notFound("project");

  const conds = [
    eq(schema.tickets.project_id, project.id),
    eq(schema.tickets.number, number),
  ];
  if (!includeDeleted) conds.push(isNull(schema.tickets.deleted_at));

  const [row] = await db.select().from(schema.tickets).where(and(...conds)).limit(1);
  if (!row) throw notFound("ticket");
  return row;
}

export async function getProjectByKey(key: string, opts: { includeArchived?: boolean } = {}) {
  const conds = [eq(schema.projects.key, key), isNull(schema.projects.deleted_at)];
  const [row] = await db.select().from(schema.projects).where(and(...conds)).limit(1);
  if (!row) throw notFound("project");
  if (!opts.includeArchived && row.archived_at) throw notFound("project");
  return row;
}

export async function getProjectById(id: string) {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, id), isNull(schema.projects.deleted_at)))
    .limit(1);
  if (!row) throw notFound("project");
  return row;
}

export async function getUserById(id: string) {
  const [row] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, id), isNull(schema.users.deleted_at)))
    .limit(1);
  if (!row) throw notFound("user");
  return row;
}

export async function getStatusById(id: string) {
  const [row] = await db.select().from(schema.statuses).where(eq(schema.statuses.id, id)).limit(1);
  if (!row) throw notFound("status");
  return row;
}
