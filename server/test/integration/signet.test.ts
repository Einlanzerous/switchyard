// SWY-165 — Signet connector proxy. Three things this asserts:
//   1. Owner gating: a non-owner member gets 403 on every /v1/signet/* route.
//   2. Degradation: with the connector unconfigured, /status answers 200
//      {configured:false} while data/command routes return 503.
//   3. Proxy happy-path: configured + a stubbed upstream `fetch` — the mirror
//      payload is parsed & relayed, and a command attributes X-Signet-Actor.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/signet.test.ts

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");
const { setSignetConfigForTests } = await import("../../src/lib/signet.js");

function buildApp() {
  const app = new OpenAPIHono();
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

const realFetch = globalThis.fetch;

async function mintToken(userId: string, scopes: string[]): Promise<string> {
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: userId,
    name: "signet-test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes,
  });
  return token;
}

function request(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const GET = (path: string, token: string) => request("GET", path, token);

async function seed() {
  const [owner] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" }).returning();
  const [member] = await testDb.insert(schema.users)
    .values({ name: "friend", type: "human", instance_role: "member" }).returning();
  return {
    owner: owner!,
    member: member!,
    ownerToken: await mintToken(owner!.id, ["read", "write"]),
    memberToken: await mintToken(member!.id, ["read", "write"]),
  };
}

beforeEach(async () => {
  await testDb.execute(sql`TRUNCATE users, projects, api_tokens RESTART IDENTITY CASCADE`);
  setSignetConfigForTests(undefined); // back to reading (unset) env
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSignetConfigForTests(undefined);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeTestDb();
});

describe("SWY-165 — owner gating", () => {
  test("a non-owner member is 403 on every signet route", async () => {
    const { memberToken } = await seed();
    setSignetConfigForTests({ baseUrl: "http://signet.test", token: "t", timeoutMs: 1000 });
    for (const path of ["/v1/signet/status", "/v1/signet/summary", "/v1/signet/secrets", "/v1/signet/audit"]) {
      const res = await GET(path, memberToken);
      expect(res.status).toBe(403);
    }
    const cmd = await request("POST", "/v1/signet/commands/sync", memberToken, { project: "p", name: "n" });
    expect(cmd.status).toBe(403);
  });
});

describe("SWY-165 — not configured", () => {
  test("status reports configured:false; data/command routes 503", async () => {
    const { ownerToken } = await seed();
    setSignetConfigForTests(null);

    const status = await GET("/v1/signet/status", ownerToken);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false, reachable: false });

    const secrets = await GET("/v1/signet/secrets", ownerToken);
    expect(secrets.status).toBe(503);
    expect((await secrets.json()).error.code).toBe("service_unavailable");

    const cmd = await request("POST", "/v1/signet/commands/sync", ownerToken, { project: "p", name: "n" });
    expect(cmd.status).toBe(503);
  });
});

describe("SWY-165 — proxy happy-path (stubbed upstream)", () => {
  test("status reflects a live daemon", async () => {
    const { ownerToken } = await seed();
    setSignetConfigForTests({ baseUrl: "http://signet.test", token: "tok", timeoutMs: 1000 });
    globalThis.fetch = (async (input: any) => {
      expect(String(input)).toBe("http://signet.test/healthz");
      return new Response(JSON.stringify({ status: "ok", version: "1.2.3" }), { status: 200 });
    }) as typeof fetch;

    const res = await GET("/v1/signet/status", ownerToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, reachable: true, version: "1.2.3" });
  });

  test("secrets are proxied, parsed, and relayed", async () => {
    const { ownerToken } = await seed();
    setSignetConfigForTests({ baseUrl: "http://signet.test", token: "tok", timeoutMs: 1000 });
    const payload = {
      projects: [{
        project: "lyceum",
        secrets: [{
          name: "API_TOKEN", status: "active", generated: true,
          version_no: 1, vhash: "a3f9c1", updated_at: "2026-07-22T00:00:00Z",
          targets: [{ kind: "gh-actions", repo: "Einlanzerous/purser", secret_name: "API_TOKEN", state: "in sync" }],
        }],
      }],
    };
    globalThis.fetch = (async (input: any) => {
      expect(String(input)).toBe("http://signet.test/v1/mirror/secrets");
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;

    const res = await GET("/v1/signet/secrets", ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects[0].project).toBe("lyceum");
    expect(body.projects[0].secrets[0].name).toBe("API_TOKEN");
  });

  test("a command forwards the body and attributes X-Signet-Actor", async () => {
    const { ownerToken } = await seed();
    setSignetConfigForTests({ baseUrl: "http://signet.test", token: "tok", timeoutMs: 1000 });
    let seenActor: string | null = null;
    let seenBody: string | null = null;
    globalThis.fetch = (async (input: any, init: any) => {
      expect(String(input)).toBe("http://signet.test/v1/commands/sync");
      seenActor = new Headers(init.headers).get("x-signet-actor");
      seenBody = init.body;
      return new Response(JSON.stringify({ results: [{ repo: "Einlanzerous/purser", ok: true }] }), { status: 200 });
    }) as typeof fetch;

    const res = await request("POST", "/v1/signet/commands/sync", ownerToken, { project: "lyceum", name: "API_TOKEN" });
    expect(res.status).toBe(200);
    expect(seenActor).toBe("magos");
    expect(JSON.parse(seenBody!)).toEqual({ project: "lyceum", name: "API_TOKEN" });
  });

  test("an upstream 404 is relayed as 404", async () => {
    const { ownerToken } = await seed();
    setSignetConfigForTests({ baseUrl: "http://signet.test", token: "tok", timeoutMs: 1000 });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "no secret lyceum/NOPE" }), { status: 404 })) as typeof fetch;

    const res = await GET("/v1/signet/secrets/lyceum/NOPE", ownerToken);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("no secret lyceum/NOPE");
  });
});
