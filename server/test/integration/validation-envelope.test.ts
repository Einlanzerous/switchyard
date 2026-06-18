// SWY-119 — request-validation failures must return the STANDARD error
// envelope (`{ error: { code, message, details } }`), not zod-openapi's native
// `{ success, error }` shape. The prod app wires `validationHook` as the
// OpenAPIHono `defaultHook`; without it, validation errors leak through and MCP
// callers see `unknown_error: (no message)`.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/validation-envelope.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

// Build the SAME app prod boots — defaultHook included — and drive it over HTTP.
const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler, validationHook } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");

function buildApp() {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

async function mintOwnerToken(): Promise<string> {
  const [owner] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" })
    .returning();
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: owner!.id,
    name: "validation-test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes: ["projects:manage"],
  });
  return token;
}

function POST(path: string, token: string, json: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

afterAll(async () => { await closeTestDb(); });

let token: string;
beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE ticket_labels, comments, attachments, tickets, project_counters,
        statuses, status_transitions, labels, projects, api_tokens,
        idempotency_keys, users RESTART IDENTITY CASCADE`
  );
  token = await mintOwnerToken();
});

describe("SWY-119 — validation error envelope", () => {
  test("invalid create_project field returns standard 400 envelope, not zod-native shape", async () => {
    const res = await POST("/v1/projects", token, {
      key: "FLOW",
      name: "Flow",
      repo_url: "not-a-url", // fails z.string().url()
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    // Standard envelope — the shape MCP's formatApiError reads.
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe("bad_request");
    expect(typeof json.error.message).toBe("string");
    expect(json.error.message.length).toBeGreaterThan(0);
    expect(json.error.message).toContain("repo_url");
    // The failing field(s) are carried for programmatic inspection.
    expect(Array.isArray(json.error.details?.issues)).toBe(true);
    // Must NOT be the zod-openapi native shape.
    expect(json.success).toBeUndefined();
  });

  test("invalid create_label color returns standard 400 envelope", async () => {
    const res = await POST("/v1/labels", token, { name: "bug", color: "red" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error?.code).toBe("bad_request");
    expect(json.error?.message).toContain("color");
    expect(json.success).toBeUndefined();
  });

  test("a valid payload still succeeds (defaultHook doesn't block success)", async () => {
    const res = await POST("/v1/labels", token, { name: "bug", color: "#ef4444" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.name).toBe("bug");
    expect(json.color).toBe("#ef4444");
  });
});
