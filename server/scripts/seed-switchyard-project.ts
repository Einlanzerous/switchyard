// Dogfood seed: populates a real "SWY" project mirroring switchyard's own
// phased build. Run once (or any time — idempotent on titles).
//
//   DATABASE_URL=postgres://switchyard_user:...@localhost:5432/switchyard \
//     bun server/scripts/seed-switchyard-project.ts
//
// What it creates:
//   - Project SWY (with default 5-status workflow)
//   - One epic per phase (0, 1, 2, 3, 4)
//   - Milestone children under each phase epic
//   - Backdated created/closed timestamps so the dashboard charts (throughput,
//     cycle time) populate with real history rather than a flat now-line
//   - For closed tickets, writes ticket.created + status_changed + closed
//     events with the backdated timestamps so the cycle-time replay finds
//     in_progress durations
//
// Idempotency: top-up by title within SWY. Re-running won't duplicate
// existing tickets but will fill in any newly-added entries below.

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

const PROJECT_KEY = "SWY";
const PROJECT_NAME = "Switchyard";
const PROJECT_DESC = "Self-hosted Jira/Vikunja replacement; ~90% agentic traffic.";

// ─── data ───────────────────────────────────────────────────────────────────
//
// Status convention:
//   "closed" → resolution=done, completed phase
//   "in_progress" → currently active
//   "backlog" → upcoming work
//
// Dates are days-ago offsets from "now" at script-run time. The exact
// numbers don't matter beyond "the chart should look like progress over
// the past several weeks", but the relative ordering is what we want.

type StatusCat = "backlog" | "planning" | "in_progress" | "blocked" | "closed";

type Milestone = {
  title: string;
  description?: string;
  started_days_ago: number;
  closed_days_ago: number | null;  // null = still open / backlog
  status: StatusCat;
};

type Phase = {
  title: string;
  description: string;
  started_days_ago: number;
  closed_days_ago: number | null;
  status: StatusCat;
  children: Milestone[];
};

const NOW_MS = Date.now();
const day = 24 * 60 * 60 * 1000;
function ago(days: number): Date { return new Date(NOW_MS - days * day); }

const PHASES: Phase[] = [
  {
    title: "Phase 0 — Contract & scaffold",
    description: "Initial OpenAPI sketch, Zod schemas, Drizzle table layout, "
      + "container scaffold. Locked the architecture before any real code.",
    started_days_ago: 38, closed_days_ago: 34, status: "closed",
    children: [
      { title: "Phase 0 · OpenAPI + Zod scaffold", started_days_ago: 38, closed_days_ago: 36, status: "closed" },
      { title: "Phase 0 · Drizzle schema draft + triggers.sql", started_days_ago: 36, closed_days_ago: 35, status: "closed" },
      { title: "Phase 0 · Container + healthz + migrate.ts", started_days_ago: 35, closed_days_ago: 34, status: "closed" },
    ],
  },
  {
    title: "Phase 1 — Backend MVP",
    description: "API routes, auth, idempotency, webhooks, events. Goal was a "
      + "fully functional read/write API agents could call before any UI shipped.",
    started_days_ago: 34, closed_days_ago: 19, status: "closed",
    children: [
      { title: "Phase 1.0 · Project + status CRUD", started_days_ago: 34, closed_days_ago: 32, status: "closed" },
      { title: "Phase 1.1 · Ticket read APIs", started_days_ago: 32, closed_days_ago: 30, status: "closed" },
      { title: "Phase 1.2 · Ticket write APIs (create/update/transition)", started_days_ago: 30, closed_days_ago: 28, status: "closed" },
      { title: "Phase 1.3 · Comments + attachments + events", started_days_ago: 28, closed_days_ago: 25, status: "closed" },
      { title: "Phase 1.6 · Closeout: correctness + DRY pass", started_days_ago: 25, closed_days_ago: 19, status: "closed" },
    ],
  },
  {
    title: "Phase 2 — Frontend",
    description: "Vue 3 + Vite + Tailwind + shadcn-vue. From login through "
      + "polished kanban + cross-project boards + settings.",
    started_days_ago: 19, closed_days_ago: 4, status: "closed",
    children: [
      { title: "Phase 2.0 · Foundations (router, theme, layout, query client)", started_days_ago: 19, closed_days_ago: 18, status: "closed" },
      { title: "Phase 2.1 · Auth flow", started_days_ago: 18, closed_days_ago: 17, status: "closed" },
      { title: "Phase 2.2 · Tickets list (virtualized)", started_days_ago: 17, closed_days_ago: 15, status: "closed" },
      { title: "Phase 2.3 · Ticket detail (drawer + page)", started_days_ago: 15, closed_days_ago: 13, status: "closed" },
      { title: "Phase 2.4 · Kanban board with drag-to-reorder", started_days_ago: 13, closed_days_ago: 10, status: "closed" },
      { title: "Phase 2.5 · Cross-project boards + swimlanes", started_days_ago: 10, closed_days_ago: 8, status: "closed" },
      { title: "Phase 2.6 · Settings (profile, tokens, labels, projects, users)", started_days_ago: 8, closed_days_ago: 6, status: "closed" },
      { title: "Phase 2.7 · Polish (Ctrl+K, shortcuts, empty states)", started_days_ago: 6, closed_days_ago: 4, status: "closed" },
    ],
  },
  {
    title: "Phase 3 — Dashboards & polish",
    description: "Stats backend, dashboards, saved views, bulk ops, "
      + "notifications, polish. SSE deferred to Phase 5.",
    started_days_ago: 4, closed_days_ago: null, status: "in_progress",
    children: [
      { title: "Phase 3.0 · Stats/aggregation backend", started_days_ago: 4, closed_days_ago: 3, status: "closed" },
      { title: "Phase 3.0b · Cumulative-flow endpoint", started_days_ago: 3, closed_days_ago: 2, status: "closed" },
      { title: "Phase 3.1 · Dashboards (HomeView + Insights tabs + Health page)", started_days_ago: 2, closed_days_ago: 0, status: "closed" },
      { title: "Phase 3.2 · Power tools (saved views + bulk operations)", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
      { title: "Phase 3.3 · Notifications / @mentions persistence", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
      { title: "Phase 3.4 · Polish & a11y", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
    ],
  },
  {
    title: "Phase 4 — Native automation rules",
    description: "Replace n8n for simple if-this-then-that rules. "
      + "Rules schema, condition DSL, actions, audit, settings UI.",
    started_days_ago: 0, closed_days_ago: null, status: "backlog",
    children: [
      { title: "Phase 4.0 · Rules schema + condition DSL", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
      { title: "Phase 4.1 · Trigger evaluator + action runner", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
      { title: "Phase 4.2 · Rules editor UI + recent firings panel", started_days_ago: 0, closed_days_ago: null, status: "backlog" },
    ],
  },
];

// ─── helpers ────────────────────────────────────────────────────────────────

async function ensureProject(): Promise<typeof schema.projects.$inferSelect> {
  let [project] = await db.select().from(schema.projects).where(eq(schema.projects.key, PROJECT_KEY)).limit(1);
  if (project) return project;
  [project] = await db.insert(schema.projects).values({
    key: PROJECT_KEY,
    name: PROJECT_NAME,
    description: PROJECT_DESC,
    color: "#3b82f6",
  }).returning();
  if (!project) throw new Error("project insert returned nothing");
  await db.insert(schema.projectCounters).values({ project_id: project.id });

  const STATUS_SEEDS = [
    { category: "backlog" as const, display_name: "Backlog", position: 0, is_default: true },
    { category: "planning" as const, display_name: "Planning", position: 1 },
    { category: "in_progress" as const, display_name: "In Progress", position: 2 },
    { category: "blocked" as const, display_name: "Blocked", position: 3 },
    { category: "closed" as const, display_name: "Closed", position: 4 },
  ];
  for (const s of STATUS_SEEDS) {
    await db.insert(schema.statuses).values({ ...s, project_id: project.id });
  }
  console.log(`[swy-seed] created project ${PROJECT_KEY} with default statuses`);
  return project;
}

type StatusByCategory = Map<StatusCat, typeof schema.statuses.$inferSelect>;

async function loadStatuses(projectId: string): Promise<StatusByCategory> {
  const rows = await db.select().from(schema.statuses).where(eq(schema.statuses.project_id, projectId));
  return new Map(rows.map((s) => [s.category as StatusCat, s]));
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

// Backdated event insert. We sidestep the writeEvent helper because it
// stamps created_at = now(); here we want fully synthetic history.
async function writeBackdatedEvent(input: {
  event_type: string;
  ticket_id: string | null;
  project_id: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}): Promise<void> {
  await db.insert(schema.events).values({
    event_type: input.event_type,
    ticket_id: input.ticket_id,
    project_id: input.project_id,
    actor_id: input.actor_id,
    payload: input.payload,
    created_at: input.created_at.toISOString(),
  });
}

type TicketSnapshot = {
  id: string;
  key: string;
  number: number;
  type: "task" | "bug" | "spike" | "epic";
  title: string;
  status: { id: string; category: StatusCat; display_name: string };
  project: { id: string; key: string; name: string; color: string | null };
};

function snapshot(t: typeof schema.tickets.$inferSelect, ctx: {
  project: typeof schema.projects.$inferSelect;
  status: typeof schema.statuses.$inferSelect;
}): TicketSnapshot {
  return {
    id: t.id,
    key: `${ctx.project.key}-${t.number}`,
    number: t.number,
    type: t.type as TicketSnapshot["type"],
    title: t.title,
    status: {
      id: ctx.status.id,
      category: ctx.status.category as StatusCat,
      display_name: ctx.status.display_name,
    },
    project: {
      id: ctx.project.id,
      key: ctx.project.key,
      name: ctx.project.name,
      color: ctx.project.color,
    },
  };
}

// Materialize a closed ticket end-to-end: insert with backdated stamps,
// emit the matching events. Skips the row entirely if a ticket with this
// title already exists in the project (dedupe).
async function materializeTicket(args: {
  project: typeof schema.projects.$inferSelect;
  statuses: StatusByCategory;
  reporter: typeof schema.users.$inferSelect;
  type: "task" | "bug" | "spike" | "epic";
  title: string;
  description: string;
  parent_id: string | null;
  status: StatusCat;          // final status
  started_days_ago: number;
  closed_days_ago: number | null;
}): Promise<typeof schema.tickets.$inferSelect | null> {
  const [existing] = await db.select().from(schema.tickets)
    .where(and(eq(schema.tickets.project_id, args.project.id), eq(schema.tickets.title, args.title)))
    .limit(1);
  if (existing) return existing;

  const finalStatus = args.statuses.get(args.status);
  if (!finalStatus) throw new Error(`status ${args.status} missing`);
  const backlog = args.statuses.get("backlog");
  if (!backlog) throw new Error("backlog status missing");
  const inProgress = args.statuses.get("in_progress");
  if (!inProgress) throw new Error("in_progress status missing");

  const number = await nextNumber(args.project.id);
  const startedAt = ago(args.started_days_ago);
  const closedAt = args.closed_days_ago != null ? ago(args.closed_days_ago) : null;
  // Tickets that closed get a halfway in_progress→closed transition so
  // cycle-time has a non-zero in_progress duration.
  const inProgressAt = closedAt
    ? new Date(startedAt.getTime() + (closedAt.getTime() - startedAt.getTime()) * 0.2)
    : null;

  const updatedAt = closedAt ?? startedAt;

  const [inserted] = await db.insert(schema.tickets).values({
    project_id: args.project.id,
    number,
    type: args.type,
    title: args.title,
    description: args.description,
    status_id: finalStatus.id,
    resolution: args.status === "closed" ? "done" : null,
    parent_id: args.parent_id,
    reporter_id: args.reporter.id,
    created_at: startedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  }).returning();
  if (!inserted) throw new Error("ticket insert returned nothing");

  const finalSnap = snapshot(inserted, { project: args.project, status: finalStatus });

  // Emit ticket.created at the started timestamp. payload.ticket records
  // the snapshot as it was at create time (with the *initial* status — we
  // synthesize that even though the row is now in its final status).
  const initialStatusForCreate = args.status === "closed"
    ? backlog            // closed tickets: emit "created in backlog" then transition
    : finalStatus;
  const initialSnap = {
    ...finalSnap,
    status: {
      id: initialStatusForCreate.id,
      category: initialStatusForCreate.category as StatusCat,
      display_name: initialStatusForCreate.display_name,
    },
  };
  await writeBackdatedEvent({
    event_type: "ticket.created",
    ticket_id: inserted.id,
    project_id: args.project.id,
    actor_id: args.reporter.id,
    payload: {
      actor: { id: args.reporter.id, name: args.reporter.name, icon: args.reporter.icon, type: args.reporter.type },
      ticket: initialSnap,
    },
    created_at: startedAt,
  });

  // Walk through in_progress → closed if applicable.
  if (closedAt && inProgressAt) {
    // backlog → in_progress
    await writeBackdatedEvent({
      event_type: "ticket.status_changed",
      ticket_id: inserted.id,
      project_id: args.project.id,
      actor_id: args.reporter.id,
      payload: {
        actor: { id: args.reporter.id, name: args.reporter.name, icon: args.reporter.icon, type: args.reporter.type },
        ticket: { ...finalSnap, status: {
          id: inProgress.id, category: inProgress.category as StatusCat, display_name: inProgress.display_name,
        } },
        changes: {
          status: {
            from: { id: backlog.id, category: "backlog", display_name: backlog.display_name },
            to: { id: inProgress.id, category: "in_progress", display_name: inProgress.display_name },
          },
        },
      },
      created_at: inProgressAt,
    });

    // in_progress → closed
    await writeBackdatedEvent({
      event_type: "ticket.status_changed",
      ticket_id: inserted.id,
      project_id: args.project.id,
      actor_id: args.reporter.id,
      payload: {
        actor: { id: args.reporter.id, name: args.reporter.name, icon: args.reporter.icon, type: args.reporter.type },
        ticket: finalSnap,
        changes: {
          status: {
            from: { id: inProgress.id, category: "in_progress", display_name: inProgress.display_name },
            to: { id: finalStatus.id, category: "closed", display_name: finalStatus.display_name },
            resolution: "done",
          },
        },
      },
      created_at: closedAt,
    });

    await writeBackdatedEvent({
      event_type: "ticket.closed",
      ticket_id: inserted.id,
      project_id: args.project.id,
      actor_id: args.reporter.id,
      payload: {
        actor: { id: args.reporter.id, name: args.reporter.name, icon: args.reporter.icon, type: args.reporter.type },
        ticket: finalSnap,
        changes: { status: {
          from: { id: inProgress.id, category: "in_progress", display_name: inProgress.display_name },
          to: { id: finalStatus.id, category: "closed", display_name: finalStatus.display_name },
          resolution: "done",
        } },
      },
      created_at: closedAt,
    });
  } else if (args.status === "in_progress") {
    // Active phase epic — emit a transition into in_progress so it shows
    // up that way in the events feed. From backlog → in_progress at started.
    await writeBackdatedEvent({
      event_type: "ticket.status_changed",
      ticket_id: inserted.id,
      project_id: args.project.id,
      actor_id: args.reporter.id,
      payload: {
        actor: { id: args.reporter.id, name: args.reporter.name, icon: args.reporter.icon, type: args.reporter.type },
        ticket: finalSnap,
        changes: { status: {
          from: { id: backlog.id, category: "backlog", display_name: backlog.display_name },
          to: { id: inProgress.id, category: "in_progress", display_name: inProgress.display_name },
        } },
      },
      created_at: new Date(startedAt.getTime() + 1000),
    });
  }

  return inserted;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const [magos] = await db.select().from(schema.users).where(eq(schema.users.name, "magos")).limit(1);
  if (!magos) {
    console.error("expected magos user — run the production seed first");
    process.exit(1);
  }

  const project = await ensureProject();
  const statuses = await loadStatuses(project.id);

  let createdEpics = 0;
  let createdMilestones = 0;
  let skipped = 0;

  for (const phase of PHASES) {
    const epic = await materializeTicket({
      project, statuses, reporter: magos,
      type: "epic",
      title: phase.title,
      description: phase.description,
      parent_id: null,
      status: phase.status,
      started_days_ago: phase.started_days_ago,
      closed_days_ago: phase.closed_days_ago,
    });
    if (!epic) {
      skipped++;
      continue;
    }
    // Was this newly created? Easy heuristic: if the row's created_at
    // matches the backdate within a few seconds, count it.
    const epicWasNew = Math.abs(
      Date.parse(epic.created_at) - ago(phase.started_days_ago).getTime()
    ) < 2000;
    if (epicWasNew) {
      createdEpics++;
      console.log(`[swy-seed] epic: ${phase.title}`);
    }

    for (const child of phase.children) {
      const t = await materializeTicket({
        project, statuses, reporter: magos,
        type: "task",
        title: child.title,
        description: child.description ?? `Milestone under ${phase.title}.`,
        parent_id: epic.id,
        status: child.status,
        started_days_ago: child.started_days_ago,
        closed_days_ago: child.closed_days_ago,
      });
      if (t && Math.abs(
        Date.parse(t.created_at) - ago(child.started_days_ago).getTime()
      ) < 2000) {
        createdMilestones++;
      }
    }
  }

  console.log(`[swy-seed] done — ${createdEpics} epics, ${createdMilestones} milestones, ${skipped} skipped`);
}

try {
  await main();
} finally {
  await client.end();
}
