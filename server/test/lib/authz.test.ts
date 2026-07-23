// Phase 6 (SWY-95) authz helper tests. Requires DATABASE_URL_TEST + a fresh
// test DB (run `bun run db:test:setup` first). The helpers query the global
// `db` (src/db.ts), so — like seed.test.ts — we point DATABASE_URL at the test
// DB before importing them, and truncate fixtures per-test.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { READ_ONLY_SCOPES, isReadOnlyScopes } from "@switchyard/shared";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const authz = await import("../../src/lib/authz.js");

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(sql`TRUNCATE users, projects RESTART IDENTITY CASCADE`);
});

async function makeUser(name: string, type: "human" | "agent", instance_role: "owner" | "member") {
  const [u] = await testDb
    .insert(schema.users)
    .values({ name, type, instance_role })
    .returning();
  return u!;
}

async function makeProject(key: string, name: string) {
  const [p] = await testDb.insert(schema.projects).values({ key, name }).returning({ id: schema.projects.id });
  return p!.id;
}

async function addMember(userId: string, projectId: string, role: "admin" | "editor" | "user" | "viewer") {
  await testDb.insert(schema.userProjects).values({ user_id: userId, project_id: projectId, role });
}

describe("hasInstanceWideAccess", () => {
  test("owner human and any agent bypass; plain member does not", () => {
    expect(authz.hasInstanceWideAccess({ type: "human", instance_role: "owner" })).toBe(true);
    expect(authz.hasInstanceWideAccess({ type: "agent", instance_role: "member" })).toBe(true);
    expect(authz.hasInstanceWideAccess({ type: "human", instance_role: "member" })).toBe(false);
  });
});

describe("visibleProjectIds", () => {
  test("owner sees every live project", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const a = await makeProject("AAA", "Alpha");
    const b = await makeProject("BBB", "Beta");
    const ids = await authz.visibleProjectIds(owner);
    expect(ids).toEqual(new Set([a, b]));
  });

  test("agent sees every live project without any membership rows", async () => {
    const agent = await makeUser("claude", "agent", "member");
    const a = await makeProject("AAA", "Alpha");
    const b = await makeProject("BBB", "Beta");
    const ids = await authz.visibleProjectIds(agent);
    expect(ids).toEqual(new Set([a, b]));
  });

  test("member sees only the projects they belong to", async () => {
    const friend = await makeUser("friend", "human", "member");
    const plex = await makeProject("PLEX", "Plex");
    await makeProject("SWY", "Switchyard"); // not a member
    await addMember(friend.id, plex, "viewer");
    const ids = await authz.visibleProjectIds(friend);
    expect(ids).toEqual(new Set([plex]));
  });

  test("member with no memberships sees nothing", async () => {
    const friend = await makeUser("friend", "human", "member");
    await makeProject("SWY", "Switchyard");
    const ids = await authz.visibleProjectIds(friend);
    expect(ids.size).toBe(0);
  });
});

describe("effectivePermissions (token scopes ∩ project role)", () => {
  test("owner with admin token gets full capabilities", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const p = await makeProject("AAA", "Alpha");
    const caps = await authz.effectivePermissions(owner, { scopes: ["admin"] }, p);
    expect(caps).toEqual(new Set(["read", "write", "delete", "manage"]));
  });

  test("agent with a read-only token is capped at read", async () => {
    const agent = await makeUser("claude", "agent", "member");
    const p = await makeProject("AAA", "Alpha");
    const caps = await authz.effectivePermissions(agent, { scopes: ["tickets:read"] }, p);
    expect(caps).toEqual(new Set(["read"]));
  });

  test("viewer role caps an admin-scoped token to read", async () => {
    const friend = await makeUser("friend", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(friend.id, p, "viewer");
    const caps = await authz.effectivePermissions(friend, { scopes: ["admin"] }, p);
    expect(caps).toEqual(new Set(["read"]));
  });

  test("a read-only token caps an editor role to read", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "editor");
    const caps = await authz.effectivePermissions(u, { scopes: ["tickets:read"] }, p);
    expect(caps).toEqual(new Set(["read"]));
  });

  test("editor role + write token yields read+write+delete, not manage", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "editor");
    const caps = await authz.effectivePermissions(u, { scopes: ["tickets:write"] }, p);
    expect(caps).toEqual(new Set(["read", "write", "delete"]));
  });

  // SWY-163: `user` is the write-without-delete tier. `write` does NOT close
  // over `delete`, so even a broad token can't lift a `user` into deletion.
  test("user role + write token yields read+write, NOT delete", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "user");
    const caps = await authz.effectivePermissions(u, { scopes: ["tickets:write"] }, p);
    expect(caps).toEqual(new Set(["read", "write"]));
  });

  test("user role caps an admin token at read+write (no delete/manage)", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "user");
    const caps = await authz.effectivePermissions(u, { scopes: ["admin"] }, p);
    expect(caps).toEqual(new Set(["read", "write"]));
  });

  test("project admin role + admin token yields full capabilities", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "admin");
    const caps = await authz.effectivePermissions(u, { scopes: ["admin"] }, p);
    expect(caps).toEqual(new Set(["read", "write", "delete", "manage"]));
  });

  test("non-member gets nothing even with an admin token", async () => {
    const friend = await makeUser("friend", "human", "member");
    const p = await makeProject("SWY", "Switchyard");
    const caps = await authz.effectivePermissions(friend, { scopes: ["admin"] }, p);
    expect(caps.size).toBe(0);
  });
});

// SWY-163: destructive routes gate on `assertCanDelete`. Delete-capable roles
// (editor/admin) and instance-wide actors delete ANY resource; a `user` may
// delete only what it authored; viewers and non-members can't delete at all.
describe("assertCanDelete (author-scoped delete)", () => {
  test("instance-wide actors (owner, agent) may delete anything", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const agent = await makeUser("claude", "agent", "member");
    const author = await makeUser("author", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await expect(authz.assertCanDelete(owner, p, "ticket", author.id)).resolves.toBeUndefined();
    await expect(authz.assertCanDelete(agent, p, "ticket", author.id)).resolves.toBeUndefined();
  });

  test("editor / admin delete any resource, even ones they didn't author", async () => {
    const editor = await makeUser("ed", "human", "member");
    const admin = await makeUser("ad", "human", "member");
    const author = await makeUser("author", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(editor.id, p, "editor");
    await addMember(admin.id, p, "admin");
    await expect(authz.assertCanDelete(editor, p, "ticket", author.id)).resolves.toBeUndefined();
    await expect(authz.assertCanDelete(admin, p, "ticket", author.id)).resolves.toBeUndefined();
  });

  test("a `user` may delete its OWN resource", async () => {
    const u = await makeUser("collab", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "user");
    await expect(authz.assertCanDelete(u, p, "ticket", u.id)).resolves.toBeUndefined();
  });

  test("a `user` may NOT delete someone else's resource", async () => {
    const u = await makeUser("collab", "human", "member");
    const author = await makeUser("author", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "user");
    await expect(authz.assertCanDelete(u, p, "ticket", author.id)).rejects.toThrow();
  });

  test("a viewer cannot delete even its own resource", async () => {
    const u = await makeUser("watcher", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "viewer");
    await expect(authz.assertCanDelete(u, p, "ticket", u.id)).rejects.toThrow();
  });

  test("a non-member cannot delete", async () => {
    const u = await makeUser("stranger", "human", "member");
    const p = await makeProject("SWY", "Switchyard");
    await expect(authz.assertCanDelete(u, p, "ticket", u.id)).rejects.toThrow();
  });
});

// 6.3 / SWY-74: a read-only `dashboard` token and a `viewer`-role human are two
// different inputs that must converge on ONE read-only outcome. effectivePermissions
// is that single predicate — both resolve to a capability set without `write`.
describe("6.3 read-only convergence (dashboard token ≡ viewer role)", () => {
  test("the dashboard scope bundle is read-only by construction", () => {
    expect(isReadOnlyScopes([...READ_ONLY_SCOPES])).toBe(true);
    expect(isReadOnlyScopes(["tickets:write"])).toBe(false);
    expect(isReadOnlyScopes(["tickets:read", "comments:write"])).toBe(false);
  });

  test("a dashboard-scoped token caps at read even on an instance-wide actor", async () => {
    // No role gate applies to an owner, so the read-only cap must come purely
    // from the capped scopes — that's the read-only-by-construction half.
    const owner = await makeUser("magos", "human", "owner");
    const p = await makeProject("AAA", "Alpha");
    const caps = await authz.effectivePermissions(owner, { scopes: [...READ_ONLY_SCOPES] }, p);
    expect(caps.has("write")).toBe(false);
    expect(caps).toEqual(new Set(["read"]));
  });

  test("a viewer-role human converges on the same read-only set, even with a broad token", async () => {
    const friend = await makeUser("friend", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(friend.id, p, "viewer");
    const caps = await authz.effectivePermissions(friend, { scopes: ["admin"] }, p);
    expect(caps.has("write")).toBe(false);
    expect(caps).toEqual(new Set(["read"]));
  });
});

describe("visibleProjectFilter (scoped-query primitive)", () => {
  test("instance-wide actors get a null filter — no scoping applied", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const agent = await makeUser("claude", "agent", "member");
    await makeProject("AAA", "Alpha");
    expect(await authz.visibleProjectFilter(owner, schema.projects.id)).toBeNull();
    expect(await authz.visibleProjectFilter(agent, schema.projects.id)).toBeNull();
  });

  test("member filter restricts a project query to their memberships", async () => {
    const friend = await makeUser("friend", "human", "member");
    const plex = await makeProject("PLEX", "Plex");
    const swy = await makeProject("SWY", "Switchyard");
    await addMember(friend.id, plex, "viewer");
    const filter = await authz.visibleProjectFilter(friend, schema.projects.id);
    expect(filter).not.toBeNull();
    const rows = await testDb.select({ id: schema.projects.id }).from(schema.projects).where(filter!);
    expect(rows.map((r) => r.id)).toEqual([plex]);
    expect(rows.find((r) => r.id === swy)).toBeUndefined();
  });

  test("member with no memberships gets a FALSE filter — zero rows, query still valid", async () => {
    const friend = await makeUser("friend", "human", "member");
    await makeProject("SWY", "Switchyard");
    const filter = await authz.visibleProjectFilter(friend, schema.projects.id);
    expect(filter).not.toBeNull();
    const rows = await testDb.select().from(schema.projects).where(filter!);
    expect(rows).toHaveLength(0);
  });
});

describe("canSeeProject", () => {
  test("instance-wide actors see any project; members only their own", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const agent = await makeUser("claude", "agent", "member");
    const friend = await makeUser("friend", "human", "member");
    const plex = await makeProject("PLEX", "Plex");
    const swy = await makeProject("SWY", "Switchyard");
    await addMember(friend.id, plex, "viewer");
    expect(await authz.canSeeProject(owner, swy)).toBe(true);
    expect(await authz.canSeeProject(agent, swy)).toBe(true);
    expect(await authz.canSeeProject(friend, plex)).toBe(true);
    expect(await authz.canSeeProject(friend, swy)).toBe(false);
  });
});

describe("assertProjectReadable (404, not 403)", () => {
  test("throws a 404 not_found for a non-member project", async () => {
    const friend = await makeUser("friend", "human", "member");
    const swy = await makeProject("SWY", "Switchyard");
    let err: any;
    try {
      await authz.assertProjectReadable(friend, swy, "ticket");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  test("resolves for a member and for instance-wide actors", async () => {
    const owner = await makeUser("magos", "human", "owner");
    const friend = await makeUser("friend", "human", "member");
    const plex = await makeProject("PLEX", "Plex");
    await addMember(friend.id, plex, "viewer");
    await expect(authz.assertProjectReadable(friend, plex, "ticket")).resolves.toBeUndefined();
    await expect(authz.assertProjectReadable(owner, plex, "ticket")).resolves.toBeUndefined();
  });
});
