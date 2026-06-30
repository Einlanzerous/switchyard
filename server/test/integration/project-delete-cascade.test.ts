// Project-delete cascade + orphan-ticket guard (SWY-127). Soft-deleting a
// project must soft-delete its tickets too, so they stop leaking into
// ticket-derived views; and the ticket list must never surface a ticket whose
// project is soft-deleted, even for a pre-existing orphan.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/project-delete-cascade.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");

function buildApp() {
  const app = new OpenAPIHono();
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

async function mintAgentToken(): Promise<string> {
  // An agent is instance-wide (bypasses project membership + role gates) and
  // has no visibleProjectFilter — exactly the case where orphan tickets would
  // otherwise leak, so it's the right actor to test the guard with.
  const [agent] = await testDb.insert(schema.users)
    .values({ name: "agent", type: "agent", instance_role: "member" }).returning();
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: agent!.id, name: "cascade-test", hashed_token: hash, token_prefix: prefix, scopes: ["admin"],
  });
  return token;
}

const GET = (path: string, token: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });
const POST = (path: string, token: string, json: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
const DELETE = (path: string, token: string) =>
  app.request(path, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE events, ticket_labels, comments, attachments, tickets,
        boards, board_projects, project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, user_projects, users
        RESTART IDENTITY CASCADE`,
  );
});

async function createProjectWithTickets(token: string, key: string, n: number) {
  const proj = await (await POST(`/v1/projects`, token, { key, name: `${key} project` })).json();
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await (await POST(`/v1/tickets`, token, { project_key: key, type: "task", title: `${key} ticket ${i + 1}` })).json();
    keys.push(t.key);
  }
  return { projectId: proj.id as string, ticketKeys: keys };
}

describe("SWY-127 — project delete cascades to its tickets", () => {
  test("deleting a project soft-deletes its tickets: gone from scoped + unscoped list + single fetch", async () => {
    const token = await mintAgentToken();
    const { ticketKeys } = await createProjectWithTickets(token, "CASC", 2);

    // Pre-delete: both tickets visible.
    expect((await (await GET(`/v1/tickets?project=CASC`, token)).json()).items).toHaveLength(2);

    const del = await DELETE(`/v1/projects/CASC`, token);
    expect(del.status).toBe(204);

    // Scoped list → empty.
    expect((await (await GET(`/v1/tickets?project=CASC`, token)).json()).items).toEqual([]);

    // Unscoped list → none of the cascaded tickets remain.
    const all = await (await GET(`/v1/tickets`, token)).json();
    const leakedKeys = all.items.map((t: any) => t.key).filter((k: string) => ticketKeys.includes(k));
    expect(leakedKeys).toEqual([]);

    // Single fetch → 404 (the ticket itself is now soft-deleted).
    expect((await GET(`/v1/tickets/${ticketKeys[0]}`, token)).status).toBe(404);
  });

  test("orphan guard: a live ticket under a manually soft-deleted project never surfaces", async () => {
    const token = await mintAgentToken();
    const { projectId, ticketKeys } = await createProjectWithTickets(token, "ORPH", 1);

    // Simulate a pre-existing orphan: soft-delete the PROJECT only, leaving the
    // ticket live (deleted_at NULL) — the exact shape that leaked before the fix.
    await testDb.update(schema.projects)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(schema.projects.id, projectId));

    // The orphan ticket is still live in the DB...
    const [row] = await testDb.select({ deleted_at: schema.tickets.deleted_at })
      .from(schema.tickets).where(eq(schema.tickets.project_id, projectId)).limit(1);
    expect(row!.deleted_at).toBeNull();

    // ...but the list guard excludes it (scoped + unscoped).
    expect((await (await GET(`/v1/tickets?project=ORPH`, token)).json()).items).toEqual([]);
    const all = await (await GET(`/v1/tickets`, token)).json();
    expect(all.items.map((t: any) => t.key)).not.toContain(ticketKeys[0]);
  });
});
