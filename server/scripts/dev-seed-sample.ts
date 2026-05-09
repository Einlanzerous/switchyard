// Dev-only sample data so the read endpoints have something to return.
// Run from the host (not inside the container) with the dev DATABASE_URL set:
//
//   DATABASE_URL=postgres://switchyard_user:...@localhost:5432/switchyard \
//     bun server/scripts/dev-seed-sample.ts
//
// Idempotent on the SAMPLE project (key=SAMPLE). Re-running adds more tickets
// rather than failing — the assumption is that you want to top-up seeded data,
// not enforce exact counts.
//
// Skipped in milestone 1.2+ because POST /v1/projects and POST /v1/tickets will
// land then; this script exists ONLY to exercise the read API in 1.1.

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

const PROJECT_KEY = "SAMPLE";
const PROJECT_NAME = "Sample Project";

type StatusSeed = {
  category: "backlog" | "planning" | "in_progress" | "blocked" | "closed";
  display_name: string;
  position: number;
  is_default?: boolean;
};

const STATUS_SEEDS: StatusSeed[] = [
  { category: "backlog", display_name: "Backlog", position: 0, is_default: true },
  { category: "planning", display_name: "Planning", position: 1 },
  { category: "in_progress", display_name: "In Progress", position: 2 },
  { category: "blocked", display_name: "Blocked", position: 3 },
  { category: "closed", display_name: "Closed", position: 4 },
];

async function main() {
  // Find magos (always present from the production seed).
  const [magos] = await db.select().from(schema.users).where(eq(schema.users.name, "magos")).limit(1);
  const [claude] = await db.select().from(schema.users).where(eq(schema.users.name, "claude")).limit(1);
  if (!magos || !claude) {
    console.error("expected magos + claude users — run the production seed first");
    process.exit(1);
  }

  // Project
  let [project] = await db.select().from(schema.projects).where(eq(schema.projects.key, PROJECT_KEY)).limit(1);
  if (!project) {
    [project] = await db.insert(schema.projects)
      .values({ key: PROJECT_KEY, name: PROJECT_NAME, color: "#3b82f6" })
      .returning();
    if (!project) throw new Error("failed to insert project");
    await db.insert(schema.projectCounters).values({ project_id: project.id });
    console.log(`[dev-seed] created project ${PROJECT_KEY}`);
  } else {
    console.log(`[dev-seed] project ${PROJECT_KEY} exists; topping up`);
  }

  // Statuses (5; planning included).
  const existingStatuses = await db.select().from(schema.statuses).where(eq(schema.statuses.project_id, project.id));
  if (existingStatuses.length === 0) {
    for (const s of STATUS_SEEDS) {
      await db.insert(schema.statuses).values({ ...s, project_id: project.id });
    }
    console.log(`[dev-seed] inserted ${STATUS_SEEDS.length} statuses`);
  }
  const statuses = await db.select().from(schema.statuses).where(eq(schema.statuses.project_id, project.id));
  const statusByCategory = new Map(statuses.map((s) => [s.category, s]));

  // Labels
  // Labels are global — seed once into the shared catalog if absent.
  for (const lbl of [
    { name: "urgent", color: "#ef4444" },
    { name: "frontend", color: "#3b82f6" },
    { name: "backend", color: "#10b981" },
  ]) {
    const [existing] = await db.select().from(schema.labels)
      .where(eq(schema.labels.name, lbl.name)).limit(1);
    if (!existing) {
      await db.insert(schema.labels).values(lbl);
    }
  }
  const labels = await db.select().from(schema.labels);

  // Tickets — top up to 10 by always inserting 2 per run, hopping categories.
  const sampleTickets: Array<{ type: "task" | "bug" | "spike" | "epic"; title: string; category: StatusSeed["category"]; assignee?: string }> = [
    { type: "task", title: "Wire shadcn-vue button into HomeView", category: "in_progress", assignee: claude.id },
    { type: "bug", title: "Health endpoint returns 200 even when migrations are pending", category: "blocked" },
    { type: "spike", title: "Investigate dispatcher backpressure under load", category: "planning" },
    { type: "task", title: "Add structured access logging", category: "backlog" },
    { type: "epic", title: "Frontend Phase 2", category: "in_progress" },
    { type: "task", title: "Migrate cogitation engine to switchyard webhooks", category: "planning", assignee: claude.id },
  ];

  for (const t of sampleTickets) {
    const status = statusByCategory.get(t.category);
    if (!status) throw new Error(`missing status for category ${t.category}`);

    // Increment counter, get next number.
    const [counter] = await db.execute<{ last_used_number: number }>(
      sql`UPDATE project_counters SET last_used_number = last_used_number + 1
          WHERE project_id = ${project.id} RETURNING last_used_number` as any
    ) as unknown as [{ last_used_number: number }];

    const [inserted] = await db.insert(schema.tickets).values({
      project_id: project.id,
      number: counter.last_used_number,
      type: t.type,
      title: t.title,
      description: `Seeded sample ticket for ${PROJECT_KEY}-${counter.last_used_number}.`,
      status_id: status.id,
      reporter_id: magos.id,
      assignee_id: t.assignee ?? null,
      priority: t.type === "bug" ? "high" : null,
    }).returning();

    if (!inserted) continue;

    // Attach a label or two.
    const lbl = labels.find((l) => l.name === (t.type === "bug" ? "backend" : "frontend"));
    if (lbl) {
      await db.insert(schema.ticketLabels).values({ ticket_id: inserted.id, label_id: lbl.id }).onConflictDoNothing();
    }

    // Comments
    await db.insert(schema.comments).values({
      ticket_id: inserted.id,
      author_id: magos.id,
      body: "Initial scope notes.",
    });
    if (t.assignee) {
      await db.insert(schema.comments).values({
        ticket_id: inserted.id,
        author_id: t.assignee,
        body: "Picked this up — will follow up shortly.",
      });
    }

    console.log(`[dev-seed] created ${PROJECT_KEY}-${counter.last_used_number} (${t.type}, ${t.category})`);
  }

  // One sample board scoped to this project.
  const [existingBoard] = await db.select().from(schema.boards).where(eq(schema.boards.name, "Sample kanban")).limit(1);
  if (!existingBoard) {
    const [board] = await db.insert(schema.boards).values({ name: "Sample kanban", layout: "kanban" }).returning();
    if (board) {
      await db.insert(schema.boardProjects).values({ board_id: board.id, project_id: project.id });
      console.log(`[dev-seed] created board "Sample kanban"`);
    }
  }

  console.log("[dev-seed] done");
}

try {
  await main();
} finally {
  await client.end();
}
