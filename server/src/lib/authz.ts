// Phase 6 authorization helpers — the two-dimensional access model.
//
// A request's effective permission on a project is the intersection of the
// token's global scopes and the user's role on that project. Owners and agents
// are instance-wide service accounts that bypass per-project membership
// entirely; a `member` human sees and acts only within the projects they hold
// a `user_projects` row for.
//
// 6.0 ships these helpers + tests only — no endpoint calls them yet. The read
// path wires them in 6.1.x (gate on `hasInstanceWideAccess` first, fall back to
// `visibleProjectIds` for scoped members), and 6.2 refines the precise
// per-endpoint write mapping on top of `effectivePermissions`.
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db.js";

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
