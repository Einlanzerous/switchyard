// Phase 6 authorization helpers — the two-dimensional access model.
//
// A request's effective permission on a project is the intersection of the
// token's global scopes and the user's role on that project. Owners and agents
// are instance-wide service accounts that bypass per-project membership
// entirely; a `member` human sees and acts only within the projects they hold
// a `user_projects` row for.
//
// 6.0 shipped the model helpers (`hasInstanceWideAccess`, `visibleProjectIds`,
// `effectivePermissions`); 6.1.0 adds the read-path enforcement primitives
// (`visibleProjectFilter`, `canSeeProject`, `assertProjectReadable`) the 6.1.x
// sub-milestones wire into handlers. No endpoint calls them yet — wiring lands
// per endpoint family in 6.1.x (gate on `hasInstanceWideAccess` first, scope
// members via `visibleProjectFilter` for lists / `assertProjectReadable` for
// detail reads), and 6.2 refines the per-endpoint write mapping on top of
// `effectivePermissions`. The written playbook lives in docs/permissions.md.
import { and, eq, inArray, isNull, sql, type Column, type SQL } from "drizzle-orm";
import { db, schema } from "../db.js";
import { forbidden, notFound } from "../errors.js";

type AuthUser = typeof schema.users.$inferSelect;
type AuthToken = typeof schema.apiTokens.$inferSelect;

/** Per-project role carried on `user_projects.role`. */
export type ProjectRole = (typeof schema.projectMemberRole.enumValues)[number];

/** Project-level capability — the closure of read ⊂ write ⊂ manage. */
export type Capability = "read" | "write" | "manage";

// Single source of the owner/agent bypass. The read/write enforcement that
// lands in 6.1+ checks this first and skips project scoping when it's true —
// never re-derive the bypass with ad-hoc `type === 'agent'` checks in handlers.
export function hasInstanceWideAccess(
  user: Pick<AuthUser, "type" | "instance_role">,
): boolean {
  return user.type === "agent" || user.instance_role === "owner";
}

// The set of project ids a user may see. Instance-wide actors get every live
// project; members get exactly the projects they have a `user_projects` row
// for. Callers in 6.1 should gate on `hasInstanceWideAccess` first and only
// fall back to this for scoped members (it's a table scan for owners/agents).
export async function visibleProjectIds(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
): Promise<Set<string>> {
  if (hasInstanceWideAccess(user)) {
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(isNull(schema.projects.deleted_at));
    return new Set(rows.map((r) => r.id));
  }
  const rows = await db
    .select({ projectId: schema.userProjects.project_id })
    .from(schema.userProjects)
    .where(eq(schema.userProjects.user_id, user.id));
  return new Set(rows.map((r) => r.projectId));
}

// Effective capabilities of (token, user) on a single project: token scopes ∩
// project role. Instance-wide actors aren't gated by membership, so their
// capability is whatever the token's scopes allow. A `member` who isn't in the
// project gets nothing. (The ticket sketched a `(user, projectId)` signature;
// scopes live on the token, which it explicitly references, so the token is a
// required third argument.)
export async function effectivePermissions(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
  token: Pick<AuthToken, "scopes">,
  projectId: string,
): Promise<Set<Capability>> {
  const tokenCaps = closure(scopeCapabilities(token.scopes));
  if (hasInstanceWideAccess(user)) return tokenCaps;

  const role = await projectRole(user.id, projectId);
  if (!role) return new Set(); // not a member → no access
  return intersect(new Set<Capability>(ROLE_CAPABILITIES[role]), tokenCaps);
}

// ─── 6.1.0 enforcement primitives ────────────────────────────────────────────
//
// The linchpin the 6.1.x read-path enforcement is built on. See
// docs/permissions.md for the written playbook these implement.

// The canonical scoped-query primitive. Returns a WHERE predicate restricting
// `projectIdCol` to the projects the user may see — to be pushed into a
// handler's existing `conds: SQL[]` array. Three cases:
//   - instance-wide actor → `null` (caller adds no filter; sees everything),
//   - scoped member       → `project_id IN (…their projects…)`,
//   - member with zero visible projects → a `FALSE` predicate.
// The FALSE branch matters: filtering at the SQL layer (rather than
// fetch-then-filter) is what keeps cursor pagination + counts correct when the
// result set is empty. NEVER fetch-then-filter — it silently breaks both.
export async function visibleProjectFilter(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
  projectIdCol: Column,
): Promise<SQL | null> {
  if (hasInstanceWideAccess(user)) return null;
  const ids = await visibleProjectIds(user);
  if (ids.size === 0) return sql`false`;
  return inArray(projectIdCol, [...ids]);
}

// True when the user may read the given project. Instance-wide actors always
// can; a `member` needs a `user_projects` row. Cheaper than `visibleProjectIds`
// for single-resource reads — one targeted membership lookup, not a full scan.
export async function canSeeProject(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
  projectId: string,
): Promise<boolean> {
  if (hasInstanceWideAccess(user)) return true;
  return (await projectRole(user.id, projectId)) !== null;
}

// Assert the user may READ a resource living in `projectId`, else throw 404 —
// deliberately NOT 403. Reads return not-found for non-member projects so a
// viewer can't probe for the existence of projects/tickets they can't see.
// (Writes use 403 + role checks; that's 6.2.) `resource` shapes the message,
// e.g. `assertProjectReadable(user, pid, "ticket")` → "ticket not found".
// Inherited resources (comments, attachments) must resolve to their parent
// ticket's project first, then pass that project id here — never their own row.
export async function assertProjectReadable(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
  projectId: string,
  resource = "resource",
): Promise<void> {
  if (await canSeeProject(user, projectId)) return;
  throw notFound(resource);
}

// ─── 6.1.5 admin-surface gate ─────────────────────────────────────────────────

// Assert the user is an instance admin (owner or agent), else throw 403 —
// deliberately 403, NOT 404. Admin surfaces (rules / targets / webhooks) are
// whole subsystems, not project-scoped resources a member could probe for
// existence, so the 404-not-403 read convention doesn't apply here: a member
// simply isn't allowed in. Reads on these surfaces gate on instance role (this
// helper) rather than token scope, so an owner's read-only token still works
// and agents keep their cross-project access. (Writes on these surfaces stay on
// the `:manage` token scope until 6.2 realigns the write path onto instance
// role.) `surface` shapes the message, e.g. "rules".
export function assertInstanceAdmin(
  user: Pick<AuthUser, "type" | "instance_role">,
  surface = "this resource",
): void {
  if (hasInstanceWideAccess(user)) return;
  throw forbidden(`${surface} is restricted to instance admins`);
}

// The set of user ids a `member` may see in the people directory: every user
// who is a co-member of a project the requester can see, ∪ all agents (instance-
// wide service accounts that appear as actors everywhere), ∪ the requester. A
// blanket directory would leak the full roster; a blanket 403 would break
// assignee / mention pickers — co-membership is the middle ground (6.1.5). The
// `null` return signals "no filter" for instance-wide actors (owner/agent),
// matching the `visibleProjectFilter` convention.
export async function visibleUserIds(
  user: Pick<AuthUser, "id" | "type" | "instance_role">,
): Promise<Set<string> | null> {
  if (hasInstanceWideAccess(user)) return null;
  const projectIds = await visibleProjectIds(user);
  const coMembers = projectIds.size > 0
    ? await db
        .select({ id: schema.userProjects.user_id })
        .from(schema.userProjects)
        .where(inArray(schema.userProjects.project_id, [...projectIds]))
    : [];
  const agents = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.type, "agent"), isNull(schema.users.deleted_at)));
  const ids = new Set<string>([user.id]);
  for (const r of coMembers) ids.add(r.id);
  for (const r of agents) ids.add(r.id);
  return ids;
}

// ─── internals ──────────────────────────────────────────────────────────────

async function projectRole(userId: string, projectId: string): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ role: schema.userProjects.role })
    .from(schema.userProjects)
    .where(
      and(
        eq(schema.userProjects.user_id, userId),
        eq(schema.userProjects.project_id, projectId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

const ROLE_CAPABILITIES: Record<ProjectRole, Capability[]> = {
  viewer: ["read"],
  editor: ["read", "write"],
  admin: ["read", "write", "manage"],
};

// What a token's global scopes permit, collapsed to the three project-level
// capabilities. `admin` grants everything; a read-only/dashboard token
// (`tickets:read`) caps at `read` regardless of project role. Kept coarse on
// purpose — 6.2 refines the precise per-endpoint mapping; here we only need the
// read/write/manage gate for the intersection.
function scopeCapabilities(scopes: readonly string[]): Set<Capability> {
  const caps = new Set<Capability>();
  if (scopes.includes("admin")) return new Set<Capability>(["read", "write", "manage"]);
  if (scopes.includes("projects:manage") || scopes.includes("users:manage")) caps.add("manage");
  const writeScopes = [
    "tickets:write",
    "comments:write",
    "attachments:write",
    "projects:manage",
    "rules:manage",
    "targets:manage",
    "webhooks:manage",
  ];
  if (writeScopes.some((s) => scopes.includes(s))) caps.add("write");
  if (scopes.includes("tickets:read")) caps.add("read");
  return caps;
}

// read ⊂ write ⊂ manage: a higher capability implies the lower ones.
function closure(caps: Set<Capability>): Set<Capability> {
  if (caps.has("manage")) caps.add("write");
  if (caps.has("write")) caps.add("read");
  return caps;
}

function intersect(a: Set<Capability>, b: Set<Capability>): Set<Capability> {
  return new Set([...a].filter((x) => b.has(x)));
}
