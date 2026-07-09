// Cloudflare Access SSO exchange (SWY-161) — POST /v1/auth/sso/cloudflare.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/auth-sso.test.ts
//
// The endpoint verifies the tunnel-injected Access JWT (Cf-Access-Jwt-Assertion
// header) against Cloudflare's JWKS. Tests inject a LOCAL keypair via
// setCfAccessKeyResolverForTests so nothing reaches the network, and toggle the
// feature via setCfAccessConfigForTests (env is parsed once at import).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const {
  setCfAccessConfigForTests,
  setCfAccessKeyResolverForTests,
} = await import("../../src/lib/cfAccess.js");

const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import("jose");

function buildApp() {
  const app = new OpenAPIHono();
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

const CFG = { teamDomain: "test-team.cloudflareaccess.com", aud: "a".repeat(64) };

// The signing keypair Cloudflare would hold. `otherKey` mimics a forged token
// signed by a key that isn't in the JWKS.
let signKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256" };
  setCfAccessKeyResolverForTests(createLocalJWKSet({ keys: [jwk] }));

  const other = await generateKeyPair("RS256");
  otherKey = other.privateKey;
});

afterAll(async () => {
  setCfAccessKeyResolverForTests(null);
  setCfAccessConfigForTests(undefined);
  await closeTestDb();
});

beforeEach(async () => {
  setCfAccessConfigForTests(CFG);
  await testDb.execute(
    sql`TRUNCATE events, api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`,
  );
});

async function sign(opts: {
  email?: string;
  iss?: string;
  aud?: string;
  exp?: string | number;
  key?: CryptoKey;
} = {}) {
  const jwt = new SignJWT({ ...(opts.email !== undefined ? { email: opts.email } : {}) })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? `https://${CFG.teamDomain}`)
    .setAudience(opts.aud ?? CFG.aud)
    .setIssuedAt();
  jwt.setExpirationTime(opts.exp ?? "5m");
  return jwt.sign(opts.key ?? signKey);
}

function POST(headers: Record<string, string> = {}) {
  return app.request("/v1/auth/sso/cloudflare", { method: "POST", headers });
}

async function seedUser(values: {
  name: string;
  email?: string | null;
  deleted?: boolean;
}) {
  const [u] = await testDb
    .insert(schema.users)
    .values({
      name: values.name,
      type: "human",
      email: values.email ?? null,
      ...(values.deleted ? { deleted_at: new Date().toISOString() } : {}),
    })
    .returning();
  return u!;
}

describe("SWY-161 — Cloudflare Access SSO", () => {
  test("feature disabled → 401 sso_disabled", async () => {
    setCfAccessConfigForTests(null);
    const res = await POST({ "cf-access-jwt-assertion": await sign({ email: "a@b.com" }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("sso_disabled");
  });

  test("missing header → 401 sso_disabled", async () => {
    const res = await POST();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("sso_disabled");
  });

  test("bad signature (unknown key) → 401 unauthorized", async () => {
    const jwt = await sign({ email: "a@b.com", key: otherKey });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("wrong audience → 401 unauthorized", async () => {
    const jwt = await sign({ email: "a@b.com", aud: "some-other-app" });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("wrong issuer → 401 unauthorized", async () => {
    const jwt = await sign({ email: "a@b.com", iss: "https://evil.example.com" });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("expired token → 401 unauthorized", async () => {
    const jwt = await sign({ email: "a@b.com", exp: Math.floor(Date.now() / 1000) - 600 });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("missing email claim → 401 unauthorized", async () => {
    const jwt = await sign({});
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("verified email with no account → 403 sso_no_account, echoes email", async () => {
    const jwt = await sign({ email: "ghost@example.com" });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("sso_no_account");
    expect(body.error.details.email).toBe("ghost@example.com");
  });

  test("soft-deleted user → 403 sso_no_account", async () => {
    await seedUser({ name: "gone", email: "gone@example.com", deleted: true });
    const jwt = await sign({ email: "gone@example.com" });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("sso_no_account");
  });

  test("happy path: case-insensitive match → 200, token authenticates /me", async () => {
    const user = await seedUser({ name: "magos", email: "magos@example.com" });
    // Cloudflare hands back a differently-cased email; we match case-insensitively.
    const jwt = await sign({ email: "Magos@Example.com" });
    const res = await POST({ "cf-access-jwt-assertion": jwt });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toMatch(/^sw_[A-Z2-7]{32}$/);
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe("magos@example.com");

    // The minted token authenticates a real request.
    const me = await app.request("/v1/users/me", {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(user.id);

    // Token row is a personal, admin-scoped "Cloudflare SSO" token.
    const [row] = await testDb
      .select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.user_id, user.id));
    expect(row?.name).toBe("Cloudflare SSO");
    expect(row?.kind).toBe("personal");
    expect(row?.scopes).toEqual(["admin"]);
  });

  test("mints a fresh token each login (no reuse)", async () => {
    await seedUser({ name: "magos", email: "magos@example.com" });
    const jwt = await sign({ email: "magos@example.com" });
    const a = await (await POST({ "cf-access-jwt-assertion": jwt })).json();
    const b = await (await POST({ "cf-access-jwt-assertion": jwt })).json();
    expect(a.token).not.toBe(b.token);
    const rows = await testDb.select().from(schema.apiTokens);
    expect(rows.length).toBe(2);
  });
});

describe("SWY-161 — user email CRUD", () => {
  let adminToken: string;

  beforeEach(async () => {
    const { generateApiToken } = await import("../../src/lib/id.js");
    const [owner] = await testDb
      .insert(schema.users)
      .values({ name: "owner", type: "human", instance_role: "owner" })
      .returning();
    const { token, hash, prefix } = generateApiToken();
    await testDb.insert(schema.apiTokens).values({
      user_id: owner!.id,
      name: "admin",
      hashed_token: hash,
      token_prefix: prefix,
      scopes: ["admin"],
    });
    adminToken = token;
  });

  function jsonReq(method: string, path: string, json: unknown) {
    return app.request(path, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(json),
    });
  }

  test("create lowercases email; duplicate active email → 409", async () => {
    const res = await jsonReq("POST", "/v1/users", {
      name: "alice",
      type: "human",
      email: "Alice@Example.com",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).email).toBe("alice@example.com");

    const dup = await jsonReq("POST", "/v1/users", {
      name: "alice2",
      type: "human",
      email: "alice@example.com",
    });
    expect(dup.status).toBe(409);
  });

  test("patch email null clears it", async () => {
    const created = await (
      await jsonReq("POST", "/v1/users", { name: "bob", type: "human", email: "bob@example.com" })
    ).json();
    const patched = await jsonReq("PATCH", `/v1/users/${created.id}`, { email: null });
    expect(patched.status).toBe(200);
    expect((await patched.json()).email).toBeNull();
  });

  test("soft-deleted user's email is reusable", async () => {
    const created = await (
      await jsonReq("POST", "/v1/users", { name: "carol", type: "human", email: "carol@example.com" })
    ).json();
    const del = await app.request(`/v1/users/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.status).toBe(204);

    const reuse = await jsonReq("POST", "/v1/users", {
      name: "carol2",
      type: "human",
      email: "carol@example.com",
    });
    expect(reuse.status).toBe(201);
  });
});
