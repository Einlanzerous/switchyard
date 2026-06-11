// E2E test fixture seed. Creates a deterministic-shape `TEST` project
// and a `test-user` human account that the Playwright suite asserts
// against.
//
//   DATABASE_URL=postgres://...@host:5432/switchyard \
//     bun server/scripts/seed-test-fixtures.ts
//
// What it creates (idempotent — re-running tops up missing rows only):
//   - User: test-user (human, instance_role=owner). Has its own bootstrap
//     token via E2E_TEST_USER_TOKEN env, otherwise the Playwright auth.setup
//     project mints one through the API at first boot. Owner so the suite sees
//     every project under Phase 6 read scoping (the realistic "primary admin
//     operating the app" role); the scoped-member read path is covered by
//     server/test/integration/negative-access.test.ts.
//   - Project: TEST (key=TEST). Default 5 statuses. Three deterministic
//     tickets:
//       TEST-1 — "Backlog ticket"     (backlog,   no assignee)
//       TEST-2 — "In progress ticket" (in_progress, assigned to test-user)
//       TEST-3 — "Closed ticket"      (closed,    resolution=done)
//   - User: viewer-user (human, instance_role=member) with a `viewer` role on
//     TEST only. Drives the permissions.spec viewer-isolation suite (6.6).
//   - Project: LOCKED (key=LOCKED). One backlog ticket (LOCKED-1). viewer-user
//     is deliberately NOT a member — the isolation target a viewer must 404 on.
//
// Tests that need to mutate state should create their own short-lived
// tickets with unique titles and let the test framework leave them; or
// use the `temp-e2e` project carved out by the test itself if isolation
// matters more than fixture stability.
//
// Keep this seed minimal and load-bearing. The full SWY dogfood seed is
// noisier and is what powers the dev dashboard; this one exists purely
// for tests to make stable assertions.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

const PROJECT_KEY = "TEST";
const PROJECT_NAME = "Test Fixtures (E2E)";
const PROJECT_DESC =
  "Deterministic seed for the Playwright suite. Treat this project as "
  + "read-only — use temp-e2e or per-test scratch tickets for write flows.";

const TEST_USER_NAME = "test-user";

// Viewer-isolation fixtures (6.6 / SWY-105). A `member` human scoped to TEST as
// a read-only viewer, plus a second project they can't see.
const VIEWER_USER_NAME = "viewer-user";
const LOCKED_PROJECT_KEY = "LOCKED";
const LOCKED_PROJECT_NAME = "Locked (E2E isolation)";
const LOCKED_PROJECT_DESC =
  "Isolation fixture — viewer-user is NOT a member. The permissions E2E asserts "
  + "a viewer 404s on this project + its tickets.";

const STATUS_SEEDS = [
  { category: "backlog" as const,     display_name: "Backlog",     position: 0, is_default: true },
  { category: "planning" as const,    display_name: "Planning",    position: 1 },
  { category: "in_progress" as const, display_name: "In Progress", position: 2 },
  { category: "blocked" as const,     display_name: "Blocked",     position: 3 },
  { category: "closed" as const,      display_name: "Closed",      position: 4 },
];

type SeedTicket = {
  title: string;
  type: "task" | "bug" | "spike" | "epic";
  category: typeof STATUS_SEEDS[number]["category"];
  resolution?: "done" | "released" | "cancelled";
  assignedToTestUser?: boolean;
};

// Stable ticket numbering relies on the project_counters row + the order
// these are inserted. As long as nothing else mutates the TEST project,
// they keep getting TEST-1, TEST-2, TEST-3.
const TICKETS: SeedTicket[] = [
  { title: "Backlog ticket",      type: "task", category: "backlog" },
  { title: "In progress ticket",  type: "task", category: "in_progress", assignedToTestUser: true },
  { title: "Closed ticket",       type: "task", category: "closed", resolution: "done" },
];

async function ensureTestUser(): Promise<typeof schema.users.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.name, TEST_USER_NAME))
    .limit(1);
  if (existing) {
    // Promote pre-Phase-6 fixtures (created with the `member` default) so the
    // suite keeps seeing every project under read scoping. Idempotent.
    if (existing.instance_role !== "owner") {
      await db
        .update(schema.users)
        .set({ instance_role: "owner" })
        .where(eq(schema.users.id, existing.id));
      console.log(`[test-seed] promoted ${TEST_USER_NAME} to instance_role=owner`);
      return { ...existing, instance_role: "owner" };
    }
    return existing;
  }
  const [created] = await db
    .insert(schema.users)
    .values({ name: TEST_USER_NAME, type: "human", instance_role: "owner" })
    .returning();
  if (!created) throw new Error("test-user insert returned nothing");
  console.log(`[test-seed] created user: ${TEST_USER_NAME} (owner)`);
  return created;
}

async function ensureViewerUser(): Promise<typeof schema.users.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.name, VIEWER_USER_NAME))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(schema.users)
    .values({ name: VIEWER_USER_NAME, type: "human", instance_role: "member" })
    .returning();
  if (!created) throw new Error("viewer-user insert returned nothing");
  console.log(`[test-seed] created user: ${VIEWER_USER_NAME} (member)`);
  return created;
}

// Idempotent `user_projects` row — the membership that scopes a member to a
// project at a role. No row = no access (the default-deny half of Phase 6).
async function ensureMembership(
  userId: string,
  projectId: string,
  role: "viewer" | "editor" | "admin",
): Promise<void> {
  const [existing] = await db
    .select()
    .from(schema.userProjects)
    .where(and(eq(schema.userProjects.user_id, userId), eq(schema.userProjects.project_id, projectId)))
    .limit(1);
  if (existing) return;
  await db.insert(schema.userProjects).values({ user_id: userId, project_id: projectId, role });
  console.log(`[test-seed] membership: ${VIEWER_USER_NAME} → ${role}`);
}

async function ensureProject(
  key: string,
  name: string,
  description: string,
  color: string,
): Promise<typeof schema.projects.$inferSelect> {
  let [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.key, key))
    .limit(1);
  if (project) return project;
  [project] = await db.insert(schema.projects).values({ key, name, description, color }).returning();
  if (!project) throw new Error(`project ${key} insert returned nothing`);
  await db.insert(schema.projectCounters).values({ project_id: project.id });
  for (const s of STATUS_SEEDS) {
    await db.insert(schema.statuses).values({ ...s, project_id: project.id });
  }
  console.log(`[test-seed] created project ${key} with default statuses`);
  return project;
}

// A single backlog ticket in the LOCKED project — the direct-fetch isolation
// target (`/tickets/LOCKED-1` must 404 for the viewer).
async function seedLockedTicket(
  project: typeof schema.projects.$inferSelect,
  reporter: typeof schema.users.$inferSelect,
): Promise<void> {
  const title = "Locked ticket";
  const [existing] = await db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.project_id, project.id), eq(schema.tickets.title, title)))
    .limit(1);
  if (existing) return;
  const [backlog] = await db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.project_id, project.id), eq(schema.statuses.category, "backlog")))
    .limit(1);
  if (!backlog) throw new Error("backlog status missing in LOCKED project");
  const number = await nextNumber(project.id);
  await db.insert(schema.tickets).values({
    project_id: project.id,
    number,
    type: "task",
    title,
    description: "Seeded for E2E isolation — a viewer must NOT be able to see this.",
    status_id: backlog.id,
    reporter_id: reporter.id,
  });
  console.log(`[test-seed] ${project.key}-${number} (backlog) — ${title}`);
}

async function nextNumber(projectId: string): Promise<number> {
  const result = await db.execute<{ last_used_number: number }>(
    sql`UPDATE project_counters SET last_used_number = last_used_number + 1
        WHERE project_id = ${projectId} RETURNING last_used_number` as any
  ) as unknown as Array<{ last_used_number: number }>;
  const row = (result as any).rows ? (result as any).rows[0] : result[0];
  if (!row) throw new Error("counter update returned nothing");
  return row.last_used_number;
}

async function seedTickets(
  project: typeof schema.projects.$inferSelect,
  reporter: typeof schema.users.$inferSelect,
  testUser: typeof schema.users.$inferSelect
) {
  const statuses = await db
    .select()
    .from(schema.statuses)
    .where(eq(schema.statuses.project_id, project.id));
  const byCategory = new Map(statuses.map((s) => [s.category, s]));

  for (const t of TICKETS) {
    const [existing] = await db
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.project_id, project.id),
          eq(schema.tickets.title, t.title)
        )
      )
      .limit(1);
    if (existing) continue;

    const status = byCategory.get(t.category);
    if (!status) throw new Error(`status ${t.category} missing in TEST project`);

    const number = await nextNumber(project.id);
    await db.insert(schema.tickets).values({
      project_id: project.id,
      number,
      type: t.type,
      title: t.title,
      description: `Seeded for E2E. Do not edit by hand — re-run seed:test-e2e.`,
      status_id: status.id,
      resolution: t.resolution ?? null,
      reporter_id: reporter.id,
      assignee_id: t.assignedToTestUser ? testUser.id : null,
    });
    console.log(`[test-seed] ${PROJECT_KEY}-${number} (${t.category}) — ${t.title}`);
  }
}

async function pruneStaleE2eSavedViews(testUser: typeof schema.users.$inferSelect) {
  // Postgres has no native row TTL, so we evaluate one lazily here:
  // every fixture run, drop any `e2e %` saved views older than an hour
  // that test-user has accumulated from prior round-trip tests. The
  // hour buffer keeps a concurrent run's just-saved view safe.
  const result = await db.execute<{ count: number }>(
    sql`DELETE FROM saved_views
        WHERE owner_id = ${testUser.id}
          AND name LIKE 'e2e %'
          AND created_at < now() - interval '1 hour'` as any
  );
  const deleted = (result as any).count ?? (result as any).rowCount ?? 0;
  if (deleted > 0) console.log(`[test-seed] pruned ${deleted} stale e2e saved views`);
}

async function main() {
  // Reporter falls back to magos so audit trails attribute "system"
  // seeded rows to a real account. test-user is the assignee where
  // tests want to assert on assignee=me-style flows.
  const [magos] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.name, "magos"))
    .limit(1);
  if (!magos) {
    console.error("expected magos user — run the production seed (db:migrate) first");
    process.exit(1);
  }

  const testUser = await ensureTestUser();
  const project = await ensureProject(PROJECT_KEY, PROJECT_NAME, PROJECT_DESC, "#10b981");
  await seedTickets(project, magos, testUser);

  // Viewer-isolation fixtures: a member scoped read-only to TEST, plus a
  // project they can't see at all (the permissions.spec target).
  const viewer = await ensureViewerUser();
  await ensureMembership(viewer.id, project.id, "viewer");
  const locked = await ensureProject(LOCKED_PROJECT_KEY, LOCKED_PROJECT_NAME, LOCKED_PROJECT_DESC, "#ef4444");
  await seedLockedTicket(locked, magos);

  await pruneStaleE2eSavedViews(testUser);

  console.log("[test-seed] done");
}

try {
  await main();
} finally {
  await client.end();
}
