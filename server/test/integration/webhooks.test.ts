// End-to-end test of the webhook fan-out.
//
// Strategy:
//   1. Truncate webhook tables + a small ticket fixture.
//   2. Spin up a Bun.serve mock receiver on a random port.
//   3. Insert a subscription pointing at the mock.
//   4. Insert an event via writeEvent (matching event_type so a delivery is enqueued).
//   5. Start the dispatcher.
//   6. Wait for the mock to receive the POST; assert headers + HMAC signature + body shape.
//
// Run with:
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/webhooks.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { signHmac, verifyHmac } from "../../src/lib/hmac.js";
import { writeEvent } from "../../src/lib/events.js";

// We point the runtime modules at the test DB.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

// Lazy import the dispatcher AFTER overriding env.
const { startDispatcher, stopDispatcher } = await import("../../src/lib/webhooks/dispatcher.js");

type Captured = {
  headers: Record<string, string>;
  body: string;
};

const captures: Captured[] = [];
let mockServer: ReturnType<typeof Bun.serve> | null = null;
let mockUrl = "";

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const body = await req.text();
      captures.push({ headers, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(async () => {
  await stopDispatcher(2_000);
  mockServer?.stop(true);
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE webhook_deliveries, webhook_subscriptions, events,
        ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
  captures.length = 0;
});

async function seedMinimalCtx() {
  // One human user + one agent.
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  // One project + counter + a backlog status (default).
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "WHK", name: "Webhook test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, project: project!, backlog: backlog! };
}

describe("webhook dispatcher end-to-end", () => {
  test("delivers a signed POST to the subscriber on ticket.created", async () => {
    const { magos, project, backlog } = await seedMinimalCtx();

    const secret = "test-secret-1234567890";
    await testDb.insert(schema.webhookSubscriptions).values({
      url: mockUrl,
      event_types: ["ticket.created"],
      secret,
      active: true,
    });

    // Create a ticket directly (no API plumbing) and emit the event via writeEvent.
    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id,
      number: 1,
      type: "task",
      title: "test webhook delivery",
      status_id: backlog.id,
      reporter_id: magos.id,
    }).returning();

    await testDb.transaction(async (tx) => {
      await writeEvent(tx as any, {
        event_type: "ticket.created",
        actor: { id: magos.id, name: magos.name, icon: magos.icon, type: magos.type },
        ticket: {
          id: ticket!.id, key: `WHK-${ticket!.number}`, number: ticket!.number,
          project: { id: project.id, key: project.key, name: project.name, color: project.color },
          type: "task", title: ticket!.title,
          status: { id: backlog.id, category: "backlog", display_name: "Backlog" },
          resolution: null, priority: null, parent_id: null,
          assignee: null,
          reporter: { id: magos.id, name: magos.name, icon: magos.icon, type: magos.type },
          due_date: null, labels: [],
          created_at: ticket!.created_at, updated_at: ticket!.updated_at, deleted_at: null,
        },
        project_id: project.id,
      });
    });

    startDispatcher();

    // Wait up to 5s for the mock to receive the POST.
    const deadline = Date.now() + 5_000;
    while (captures.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(captures.length).toBeGreaterThan(0);

    const c = captures[0]!;
    expect(c.headers["content-type"]).toContain("application/json");
    expect(c.headers["x-switchyard-event"]).toBe("ticket.created");
    expect(c.headers["x-switchyard-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify HMAC.
    const sig = c.headers["x-switchyard-signature"]!;
    expect(verifyHmac(secret, c.body, sig)).toBe(true);

    // And spot-check the body shape.
    const parsed = JSON.parse(c.body);
    expect(parsed.event).toBe("ticket.created");
    expect(parsed.ticket?.key).toBe("WHK-1");
    expect(parsed.actor?.name).toBe("magos");

    // Delivery row should have transitioned to succeeded.
    const [delivery] = await testDb.select().from(schema.webhookDeliveries).limit(1);
    expect(delivery!.status).toBe("succeeded");
    expect(delivery!.response_code).toBe(200);

    // Non-zero verification hash for paranoia: the signing helper should
    // produce identical output when given the body we received.
    expect(signHmac(secret, c.body)).toBe(sig.replace(/^sha256=/, ""));

    // Stop dispatcher between tests so the next test starts clean.
    await stopDispatcher(1_000);
  }, 15_000);
});
