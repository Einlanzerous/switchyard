// Phase 6 (SWY-95) authz helper tests. Requires DATABASE_URL_TEST + a fresh
// test DB (run `bun run db:test:setup` first). The helpers query the global
// `db` (src/db.ts), so — like seed.test.ts — we point DATABASE_URL at the test
// DB before importing them, and truncate fixtures per-test.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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

async function addMember(userId: string, projectId: string, role: "admin" | "editor" | "viewer") {
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
    expect(caps).toEqual(new Set(["read", "write", "manage"]));
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

  test("editor role + write token yields read+write, not manage", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "editor");
    const caps = await authz.effectivePermissions(u, { scopes: ["tickets:write"] }, p);
    expect(caps).toEqual(new Set(["read", "write"]));
  });

  test("project admin role + admin token yields full capabilities", async () => {
    const u = await makeUser("dev", "human", "member");
    const p = await makeProject("PLEX", "Plex");
    await addMember(u.id, p, "admin");
    const caps = await authz.effectivePermissions(u, { scopes: ["admin"] }, p);
    expect(caps).toEqual(new Set(["read", "write", "manage"]));
  });

  test("non-member gets nothing even with an admin token", async () => {
    const friend = await makeUser("friend", "human", "member");
    const p = await makeProject("SWY", "Switchyard");
    const caps = await authz.effectivePermissions(friend, { scopes: ["admin"] }, p);
    expect(caps.size).toBe(0);
  });
});
