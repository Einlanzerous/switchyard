// E2E test fixture seed. Creates a deterministic-shape `TEST` project
// and a `test-user` human account that the Playwright suite asserts
// against.
//
//   DATABASE_URL=postgres://...@host:5432/switchyard \
//     bun server/scripts/seed-test-fixtures.ts
//
// What it creates (idempotent — re-running tops up missing rows only):
//   - User: test-user (human). Has its own bootstrap token via
//     E2E_TEST_USER_TOKEN env, otherwise the Playwright auth.setup
//     project mints one through the API at first boot.
//   - Project: TEST (key=TEST). Default 5 statuses. Three deterministic
//     tickets:
//       TEST-1 — "Backlog ticket"     (backlog,   no assignee)
//       TEST-2 — "In progress ticket" (in_progress, assigned to test-user)
//       TEST-3 — "Closed ticket"      (closed,    resolution=done)
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
  if (existing) return existing;
  const [created] = await db
    .insert(schema.users)
    .values({ name: TEST_USER_NAME, type: "human" })
    .returning();
  if (!created) throw new Error("test-user insert returned nothing");
  console.log(`[test-seed] created user: ${TEST_USER_NAME}`);
  return created;
}

async function ensureProject(reporter: typeof schema.users.$inferSelect): Promise<typeof schema.projects.$inferSelect> {
  let [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.key, PROJECT_KEY))
    .limit(1);
  if (project) return project;
  [project] = await db.insert(schema.projects).values({
    key: PROJECT_KEY,
    name: PROJECT_NAME,
    description: PROJECT_DESC,
    color: "#10b981",
  }).returning();
  if (!project) throw new Error("project insert returned nothing");
  await db.insert(schema.projectCounters).values({ project_id: project.id });
  for (const s of STATUS_SEEDS) {
    await db.insert(schema.statuses).values({ ...s, project_id: project.id });
  }
  console.log(`[test-seed] created project ${PROJECT_KEY} with default statuses`);
  void reporter;
  return project;
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
  const project = await ensureProject(magos);
  await seedTickets(project, magos, testUser);

  console.log("[test-seed] done");
}

try {
  await main();
} finally {
  await client.end();
}
