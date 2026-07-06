// Dev-only insights history seed (SWY-149–152 demo data).
//
//   DATABASE_URL=postgres://... bun server/scripts/dev-seed-insights.ts
//
// Builds ~9 months of closure history in the SAMPLE project so the Insights
// surfaces have something real to show:
//
//   - pre-agent era (52→17 weeks ago): 1-2 closes/week, all human (magos),
//     multi-day cycle times — this is the "before" the SWY-152 median-cycle
//     baseline compares against
//   - agent era (16 weeks ago → now): claude closes 4-9/week with sub-day
//     cycles, rules-engine + external-ref-poller sprinkle automation closes,
//     magos stays at 1-3/week — force multiplier lands around 3-5×
//   - last 7 days: 1-4 closes/day so the 7D daily view is dense
//   - a few open backlog/planning/in-progress tickets (two agent-assigned,
//     for the "driven by agents" KPI subline)
//
// Assignee-vs-actor variety on purpose: ~30% of claude's tickets are CLOSED
// by external-ref-poller (the PR-merge auto-close shape) — under the
// leaderboard's `attribute=assignee` those still credit claude; rules-engine
// closes are unassigned, so they fall back to the automation itself.
//
// Events are written in the exact payload shapes the stats layer replays:
// ticket.created {ticket.status.category}, ticket.status_changed
// {changes.status.from/to.category}, ticket.closed {ticket.key/type}.
//
// Deterministic (seeded PRNG) and guarded: if SAMPLE already has closure
// history it exits instead of doubling the data.

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
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

// mulberry32 — deterministic runs so re-seeding a wiped DB gives the same
// believable shape every time.
let rngState = 0x5eed1234;
function rnd(): number {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

const VERBS = [
  "Wire up", "Refactor", "Fix flaky", "Add retries to", "Instrument",
  "Migrate", "Document", "Harden", "Speed up", "Deduplicate",
  "Add tests for", "Rate-limit", "Cache", "Paginate", "Backfill",
];
const OBJECTS = [
  "webhook dispatcher", "n8n export flow", "board drag-and-drop",
  "ticket search DSL", "notification fanout", "cursor pagination",
  "event replay path", "attachment sniffing", "label catalog sync",
  "status transition guard", "idempotency key sweep", "activity feed query",
  "mention detection", "saved view filters", "health probe timings",
  "container build cache", "Postgres vacuum schedule", "reverse proxy config",
];
const title = () => `${pick(VERBS)} ${pick(OBJECTS)}`;

async function ensureAgent(name: string) {
  const [existing] = await db.select().from(schema.users)
    .where(eq(schema.users.name, name)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.users)
    .values({ name, type: "agent" }).returning();
  console.log(`[seed-insights] created agent user ${name}`);
  return created!;
}

async function main() {
  const [magos] = await db.select().from(schema.users).where(eq(schema.users.name, "magos")).limit(1);
  const [claude] = await db.select().from(schema.users).where(eq(schema.users.name, "claude")).limit(1);
  if (!magos || !claude) {
    console.error("expected magos + claude users — run db:migrate first");
    process.exit(1);
  }
  const rulesEngine = await ensureAgent("rules-engine");
  const poller = await ensureAgent("external-ref-poller");

  const [project] = await db.select().from(schema.projects)
    .where(eq(schema.projects.key, PROJECT_KEY)).limit(1);
  if (!project) {
    console.error(`project ${PROJECT_KEY} missing — run dev:seed-sample first`);
    process.exit(1);
  }

  const statuses = await db.select().from(schema.statuses)
    .where(eq(schema.statuses.project_id, project.id));
  const byCat = new Map(statuses.map((s) => [s.category, s]));
  const backlog = byCat.get("backlog");
  const planning = byCat.get("planning");
  const inProgress = byCat.get("in_progress");
  const closed = byCat.get("closed");
  if (!backlog || !planning || !inProgress || !closed) {
    console.error("SAMPLE is missing canonical statuses — run dev:seed-sample first");
    process.exit(1);
  }

  // Guard: don't double history on re-run.
  const [{ n }] = ((await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM events
    WHERE project_id = ${project.id} AND event_type = 'ticket.closed'
  `)) as any).rows ?? [{ n: 0 }];
  if (n > 20) {
    console.log(`[seed-insights] SAMPLE already has ${n} closure events — nothing to do`);
    return;
  }

  async function nextNumber(): Promise<number> {
    const res = await db.execute<{ last_used_number: number }>(sql`
      UPDATE project_counters SET last_used_number = last_used_number + 1
      WHERE project_id = ${project!.id} RETURNING last_used_number
    `);
    return (((res as any).rows ?? res)[0] as { last_used_number: number }).last_used_number;
  }

  type Ev = {
    type: string;
    at: number;
    actor: string | null;
    payload: unknown;
  };

  async function insertTicket(opts: {
    type: "task" | "bug" | "spike";
    statusId: string;
    assignee: string | null;
    reporter: string;
    createdAt: number;
    updatedAt: number;
    resolution?: "done";
    events: Ev[];
  }) {
    const num = await nextNumber();
    const key = `${PROJECT_KEY}-${num}`;
    const [t] = await db.insert(schema.tickets).values({
      project_id: project!.id,
      number: num,
      type: opts.type,
      title: title(),
      description: "Seeded insights-history ticket.",
      status_id: opts.statusId,
      reporter_id: opts.reporter,
      assignee_id: opts.assignee,
      resolution: opts.resolution ?? null,
      created_at: new Date(opts.createdAt).toISOString(),
      updated_at: new Date(opts.updatedAt).toISOString(),
    }).returning();
    if (!t) throw new Error(`insert failed for ${key}`);
    for (const e of opts.events) {
      await db.insert(schema.events).values({
        project_id: project!.id,
        ticket_id: t.id,
        event_type: e.type,
        actor_id: e.actor,
        payload: e.payload as any,
        created_at: new Date(e.at).toISOString(),
      });
    }
    return { id: t.id, key };
  }

  // One fully-evented closed ticket: created (backlog) → in_progress → closed.
  async function closedTicket(opts: {
    assignee: string | null;
    closeActor: string;
    closedAt: number;
    cycleMs: number;   // time spent in_progress
    leadMs: number;    // backlog dwell before work started
    type?: "task" | "bug" | "spike";
  }) {
    const type = opts.type ?? (rnd() < 0.2 ? "bug" : "task");
    const startedAt = opts.closedAt - opts.cycleMs;
    const createdAt = startedAt - opts.leadMs;
    const reporter = rnd() < 0.75 ? magos!.id : claude!.id;
    const num = await nextNumber();
    const key = `${PROJECT_KEY}-${num}`;
    const [t] = await db.insert(schema.tickets).values({
      project_id: project!.id,
      number: num,
      type,
      title: title(),
      description: "Seeded insights-history ticket.",
      status_id: closed!.id,
      reporter_id: reporter,
      assignee_id: opts.assignee,
      resolution: "done",
      created_at: new Date(createdAt).toISOString(),
      updated_at: new Date(opts.closedAt).toISOString(),
    }).returning();
    if (!t) throw new Error(`insert failed for ${key}`);

    const events: Ev[] = [
      {
        type: "ticket.created", at: createdAt, actor: reporter,
        payload: { ticket: { key, type, status: { category: "backlog" } } },
      },
      {
        type: "ticket.status_changed", at: startedAt, actor: opts.assignee ?? opts.closeActor,
        payload: { changes: { status: { from: { category: "backlog" }, to: { category: "in_progress" } } } },
      },
      {
        type: "ticket.status_changed", at: opts.closedAt, actor: opts.closeActor,
        payload: { changes: { status: { from: { category: "in_progress" }, to: { category: "closed" } } } },
      },
      {
        type: "ticket.closed", at: opts.closedAt, actor: opts.closeActor,
        payload: { ticket: { key, type } },
      },
    ];
    for (const e of events) {
      await db.insert(schema.events).values({
        project_id: project!.id,
        ticket_id: t.id,
        event_type: e.type,
        actor_id: e.actor,
        payload: e.payload as any,
        created_at: new Date(e.at).toISOString(),
      });
    }
  }

  const now = Date.now();
  let count = 0;

  // ── Pre-agent era: 52→17 weeks ago, human-only, slow cycles ──────────────
  for (let w = 52; w >= 17; w--) {
    const closes = int(1, 2);
    for (let i = 0; i < closes; i++) {
      await closedTicket({
        assignee: rnd() < 0.7 ? magos.id : null,
        closeActor: magos.id,
        closedAt: now - w * 7 * DAY + between(0, 6 * DAY),
        cycleMs: between(1 * DAY, 5 * DAY),
        leadMs: between(1 * DAY, 10 * DAY),
      });
      count++;
    }
  }
  console.log(`[seed-insights] pre-agent era: ${count} closures`);

  // ── Agent era: 16→1 weeks ago ─────────────────────────────────────────────
  const eraStart = count;
  for (let w = 16; w >= 1; w--) {
    // Agents ramp up over the era.
    const ramp = (17 - w) / 16; // 1/16 .. 1
    const claudeCloses = int(2, 3 + Math.round(6 * ramp));
    for (let i = 0; i < claudeCloses; i++) {
      await closedTicket({
        assignee: claude.id,
        // ~30% of claude's tickets get closed by the PR-merge poller — the
        // assignee-attribution case the leaderboard exists to get right.
        closeActor: rnd() < 0.3 ? poller.id : claude.id,
        closedAt: now - w * 7 * DAY + between(0, 6 * DAY),
        cycleMs: between(20 * MIN, 8 * HOUR),
        leadMs: between(2 * HOUR, 3 * DAY),
      });
      count++;
    }
    const ruleCloses = int(0, 2);
    for (let i = 0; i < ruleCloses; i++) {
      await closedTicket({
        assignee: null, // unassigned automation close → actor fallback
        closeActor: rulesEngine.id,
        closedAt: now - w * 7 * DAY + between(0, 6 * DAY),
        cycleMs: between(1 * MIN, 15 * MIN),
        leadMs: between(1 * HOUR, 1 * DAY),
      });
      count++;
    }
    const magosCloses = int(1, 3);
    for (let i = 0; i < magosCloses; i++) {
      await closedTicket({
        assignee: magos.id,
        closeActor: magos.id,
        closedAt: now - w * 7 * DAY + between(0, 6 * DAY),
        cycleMs: between(3 * HOUR, 1.5 * DAY),
        leadMs: between(4 * HOUR, 4 * DAY),
      });
      count++;
    }
  }
  console.log(`[seed-insights] agent era: ${count - eraStart} closures`);

  // ── Last 7 days: dense daily activity for the 7D view ────────────────────
  const weekStart = count;
  for (let d = 6; d >= 0; d--) {
    const claudeCloses = int(1, 3);
    for (let i = 0; i < claudeCloses; i++) {
      await closedTicket({
        assignee: claude.id,
        closeActor: rnd() < 0.3 ? poller.id : claude.id,
        closedAt: now - d * DAY - between(0, 20 * HOUR),
        cycleMs: between(15 * MIN, 6 * HOUR),
        leadMs: between(1 * HOUR, 2 * DAY),
      });
      count++;
    }
    if (rnd() < 0.5) {
      await closedTicket({
        assignee: magos.id,
        closeActor: magos.id,
        closedAt: now - d * DAY - between(0, 20 * HOUR),
        cycleMs: between(2 * HOUR, 12 * HOUR),
        leadMs: between(2 * HOUR, 2 * DAY),
      });
      count++;
    }
  }
  console.log(`[seed-insights] last 7 days: ${count - weekStart} closures`);

  // ── Open work: backlog/planning spread + agent-driven in-progress ────────
  for (let i = 0; i < 8; i++) {
    const createdAt = now - between(1 * DAY, 60 * DAY);
    const isPlanning = rnd() < 0.4;
    await insertTicket({
      type: rnd() < 0.2 ? "spike" : "task",
      statusId: isPlanning ? planning.id : backlog.id,
      assignee: null,
      reporter: magos.id,
      createdAt,
      updatedAt: createdAt,
      events: [
        {
          type: "ticket.created", at: createdAt, actor: magos.id,
          payload: { ticket: { status: { category: "backlog" } } },
        },
        ...(isPlanning
          ? [{
              type: "ticket.status_changed", at: createdAt + between(1 * HOUR, 3 * DAY), actor: magos.id,
              payload: { changes: { status: { from: { category: "backlog" }, to: { category: "planning" } } } },
            }]
          : []),
      ],
    });
  }
  for (const assignee of [claude.id, rulesEngine.id, magos.id]) {
    const createdAt = now - between(2 * DAY, 10 * DAY);
    const startedAt = now - between(2 * HOUR, 2 * DAY);
    await insertTicket({
      type: "task",
      statusId: inProgress.id,
      assignee,
      reporter: magos.id,
      createdAt,
      updatedAt: startedAt,
      events: [
        {
          type: "ticket.created", at: createdAt, actor: magos.id,
          payload: { ticket: { status: { category: "backlog" } } },
        },
        {
          type: "ticket.status_changed", at: startedAt, actor: assignee,
          payload: { changes: { status: { from: { category: "backlog" }, to: { category: "in_progress" } } } },
        },
      ],
    });
  }
  console.log("[seed-insights] open work: 8 backlog/planning + 3 in-progress (2 agent-driven)");

  // ── Make sure SAMPLE is actually on the "All projects" board ─────────────
  const [allBoard] = await db.select().from(schema.boards)
    .where(eq(schema.boards.name, "All projects")).limit(1);
  if (allBoard) {
    const [member] = await db.select().from(schema.boardProjects).where(and(
      eq(schema.boardProjects.board_id, allBoard.id),
      eq(schema.boardProjects.project_id, project.id),
    )).limit(1);
    if (!member) {
      await db.insert(schema.boardProjects).values({ board_id: allBoard.id, project_id: project.id });
      console.log(`[seed-insights] attached ${PROJECT_KEY} to the "All projects" board`);
    }
  }

  console.log(`[seed-insights] done — ${count} closed tickets with full event history`);
}

try {
  await main();
} finally {
  await client.end();
}
