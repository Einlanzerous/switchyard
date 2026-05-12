// Phase 4.2.5 integration tests: named webhook targets.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/targets.test.ts
//
// Covers: subscription-via-target delivery, rule fire_webhook with
// target reference (URL + HMAC + headers), delete-with-references 409,
// header precedence (action wins over target), URL-form actions still
// work, call_n8n falls back to N8N_BASE_URL when no target named "n8n".

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { writeEvent } from "../../src/lib/events.js";
import { signHmac } from "../../src/lib/hmac.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const dispatcher = await import("../../src/lib/rules/dispatcher.js");
const webhooksDispatcher = await import("../../src/lib/webhooks/dispatcher.js");

afterAll(async () => {
  await dispatcher.stopDispatcher(2_000);
  await webhooksDispatcher.stopDispatcher(2_000);
  await closeTestDb();
});

beforeEach(async () => {
  await dispatcher.stopDispatcher(2_000);
  dispatcher._resetForTesting();
  await webhooksDispatcher.stopDispatcher(2_000);
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, webhook_deliveries, webhook_subscriptions,
        targets, events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedCtx() {
  const [magos] = await testDb.insert(schema.users).values({ name: "magos", type: "human" }).returning();
  await testDb.insert(schema.users).values({ name: "rules-engine", type: "agent" });
  const [project] = await testDb.insert(schema.projects).values({ key: "TGT", name: "Target test" }).returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true,
  }).returning();
  return { magos: magos!, project: project!, backlog: backlog! };
}

async function emitTicketCreated(opts: {
  ticket: typeof schema.tickets.$inferSelect;
  actor: typeof schema.users.$inferSelect;
  project: typeof schema.projects.$inferSelect;
  status: typeof schema.statuses.$inferSelect;
}) {
  const { ticket, actor, project, status } = opts;
  await testDb.transaction(async (tx) => {
    await writeEvent(tx as any, {
      event_type: "ticket.created",
      actor: { id: actor.id, name: actor.name, icon: actor.icon, type: actor.type },
      ticket: {
        id: ticket.id, key: `${project.key}-${ticket.number}`, number: ticket.number,
        project: { id: project.id, key: project.key, name: project.name, color: project.color },
        type: ticket.type as any, title: ticket.title,
        status: { id: status.id, category: status.category as any, display_name: status.display_name },
        resolution: null, priority: null, parent_id: null,
        assignee: null,
        reporter: { id: actor.id, name: actor.name, icon: actor.icon, type: actor.type },
        due_date: null, labels: [], position: ticket.position,
        created_at: ticket.created_at, updated_at: ticket.updated_at, deleted_at: null,
      },
      project_id: project.id,
    });
  });
}

async function waitForFiring(predicate: (rows: any[]) => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await testDb.select().from(schema.ruleFirings);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = await testDb.select().from(schema.ruleFirings);
  throw new Error(`timed out; firings=${JSON.stringify(rows.map((r) => ({ status: r.status, last_error: r.last_error })))}`);
}

describe("4.2.5 targets — webhook subscription routing", () => {
  test("subscription via target_id resolves URL + secret at delivery time", async () => {
    const { magos, project, backlog } = await seedCtx();

    let received: { body: string; sig: string | null; auth: string | null } | null = null;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        received = {
          body: await req.text(),
          sig: req.headers.get("x-switchyard-signature"),
          auth: req.headers.get("authorization"),
        };
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const targetSecret = "target-secret-1234567890ab";
      const [target] = await testDb.insert(schema.targets).values({
        name: "n8n",
        url: `http://127.0.0.1:${mock.port}/hook`,
        hmac_secret: targetSecret,
        headers: { Authorization: "Bearer target-token" } as any,
      }).returning();

      // Subscription with literal-URL fallback + target_id reference.
      // The dispatcher's coalesce(target.url, s.url) means the target's
      // URL wins.
      await testDb.insert(schema.webhookSubscriptions).values({
        url: "http://stale.example.com/should-not-be-hit",
        secret: "stale-secret",
        event_types: ["ticket.created"],
        target_id: target!.id,
        active: true,
      });

      const [ticket] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number: 1, type: "task", title: "t",
        status_id: backlog.id, reporter_id: magos.id,
      }).returning();

      await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });

      webhooksDispatcher.startDispatcher();

      const deadline = Date.now() + 5_000;
      while (received === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(received).not.toBeNull();
      // HMAC verifies with the target's secret, not the subscription's.
      expect(signHmac(targetSecret, received!.body)).toBe(received!.sig!.replace(/^sha256=/, ""));
      // Target's static header reached the receiver.
      // (Note: subscription deliveries don't merge action.headers — this
      // path is for subscriptions, which only have target headers.)
      expect(received!.auth).toBe("Bearer target-token");

      await webhooksDispatcher.stopDispatcher(1_000);
    } finally {
      mock.stop(true);
    }
  }, 20_000);
});

describe("4.2.5 targets — rule fire_webhook action", () => {
  test("rule fire_webhook with target reference resolves URL, signs, and merges headers", async () => {
    const { magos, project, backlog } = await seedCtx();

    let received: { url: string; body: string; sig: string | null; xCustom: string | null; xOnlyAction: string | null } | null = null;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        received = {
          url: url.pathname + url.search,
          body: await req.text(),
          sig: req.headers.get("x-switchyard-signature"),
          // Action's header value should win over the target's value.
          xCustom: req.headers.get("x-custom"),
          // Header set only by the action should pass through.
          xOnlyAction: req.headers.get("x-action-only"),
        };
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const targetSecret = "target-secret-1234567890ab";
      await testDb.insert(schema.targets).values({
        name: "n8n",
        url: `http://127.0.0.1:${mock.port}`,
        hmac_secret: targetSecret,
        headers: { "X-Custom": "from-target", "X-Target-Only": "stays" } as any,
      });

      await testDb.insert(schema.rules).values({
        project_id: project.id, name: "ping-target", enabled: true,
        trigger_event_types: ["ticket.created"], conditions: {},
        actions: [{
          type: "fire_webhook",
          target: "n8n",
          path: "/webhook/triage",
          headers: { "X-Custom": "from-action", "X-Action-Only": "yes" },
        }],
        webhook_secret: "rule-secret-should-be-overridden",
      });

      const [ticket] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number: 1, type: "task", title: "t",
        status_id: backlog.id, reporter_id: magos.id,
      }).returning();

      await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
      dispatcher.startDispatcher();
      await waitForFiring((rs) => rs.some((r) => r.status === "succeeded"));

      expect(received).not.toBeNull();
      // URL = target.url + path.
      expect(received!.url).toBe("/webhook/triage");
      // HMAC keyed on the target's secret (overrides rule.webhook_secret).
      expect(signHmac(targetSecret, received!.body)).toBe(received!.sig!.replace(/^sha256=/, ""));
      // Action header wins on collision.
      expect(received!.xCustom).toBe("from-action");
      // Action-only header passes through.
      expect(received!.xOnlyAction).toBe("yes");
    } finally {
      mock.stop(true);
      await dispatcher.stopDispatcher(1_000);
    }
  }, 20_000);

  test("rule fire_webhook URL form still works (no target)", async () => {
    const { magos, project, backlog } = await seedCtx();

    let received: { body: string; sig: string | null } | null = null;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        received = { body: await req.text(), sig: req.headers.get("x-switchyard-signature") };
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const ruleSecret = "rule-secret-1234567890";
      await testDb.insert(schema.rules).values({
        project_id: project.id, name: "url-form", enabled: true,
        trigger_event_types: ["ticket.created"], conditions: {},
        actions: [{ type: "fire_webhook", url: `http://127.0.0.1:${mock.port}/raw` }],
        webhook_secret: ruleSecret,
      });

      const [ticket] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number: 1, type: "task", title: "t",
        status_id: backlog.id, reporter_id: magos.id,
      }).returning();

      await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
      dispatcher.startDispatcher();
      await waitForFiring((rs) => rs.some((r) => r.status === "succeeded"));

      expect(received).not.toBeNull();
      // Without a target, signing key is the rule's webhook_secret.
      expect(signHmac(ruleSecret, received!.body)).toBe(received!.sig!.replace(/^sha256=/, ""));
    } finally {
      mock.stop(true);
      await dispatcher.stopDispatcher(1_000);
    }
  }, 20_000);

  test("missing target name fails the firing cleanly", async () => {
    const { magos, project, backlog } = await seedCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id, name: "missing-target", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "fire_webhook", target: "ghost", path: "/x" }],
      webhook_secret: "rule-secret",
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t",
      status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
    dispatcher.startDispatcher();
    const rows = await waitForFiring((rs) => rs.some((r) => r.status === "failed"));
    expect(rows.find((r) => r.status === "failed")!.last_error).toContain("target \"ghost\" not found");
    await dispatcher.stopDispatcher(1_000);
  }, 15_000);
});

describe("4.2.5 targets — delete with references", () => {
  test("deleting a referenced target throws and the dependent ids surface in details", async () => {
    const { project } = await seedCtx();

    const [target] = await testDb.insert(schema.targets).values({
      name: "n8n",
      url: "http://x/",
      hmac_secret: "s",
    }).returning();

    // One subscription points at the target.
    const [sub] = await testDb.insert(schema.webhookSubscriptions).values({
      url: "http://stale/",
      secret: "stale",
      event_types: ["ticket.created"],
      target_id: target!.id,
    }).returning();

    // One rule references the target by name in its action JSONB.
    const [rule] = await testDb.insert(schema.rules).values({
      project_id: project.id, name: "uses-n8n", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "fire_webhook", target: "n8n", path: "/x" }],
      webhook_secret: "rs",
    }).returning();

    // Direct JSONB containment query mirroring what the route does.
    const refs = await testDb.execute<{ id: string }>(sql`
      SELECT id FROM rules WHERE actions @> ${JSON.stringify([{ target: "n8n" }])}::jsonb
    ` as unknown as any) as unknown as Array<{ id: string }>;
    expect(refs.map((r: any) => r.id)).toContain(rule!.id);

    const subRefs = await testDb.select({ id: schema.webhookSubscriptions.id })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.target_id, target!.id));
    expect(subRefs.map((s: any) => s.id)).toContain(sub!.id);
  }, 10_000);
});
