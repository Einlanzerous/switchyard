// Integration test for the seed routine. Requires DATABASE_URL_TEST + a fresh
// test DB (run `bun run db:test:setup` first).
//
// Strategy: seed twice and assert idempotency. We don't roll back via withTx
// here because seed runs its own queries via the global db client.
//
// To keep test runs isolated from each other we truncate the relevant tables
// at the top of each test and rely on the test process exiting cleanly.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

// We point the seed module at the test DB by overriding env before import.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(sql`TRUNCATE api_tokens, users RESTART IDENTITY CASCADE`);
});

describe("seed", () => {
  test("creates 7 canonical users on first run", async () => {
    delete process.env.BOOTSTRAP_TOKEN;
    const { seed } = await import("../../src/lib/seed.js");
    await seed();
    const users = await testDb.select().from(schema.users);
    expect(users).toHaveLength(7);
    const names = users.map((u) => u.name).sort();
    expect(names).toEqual([
      "autosavant-bot",
      "claude",
      "magos",
      "n8n-cogitation",
      "n8n-vox-dictate",
      "rules-engine",
      "servo-signal",
    ]);
  });

  test("re-running is a no-op (idempotent)", async () => {
    delete process.env.BOOTSTRAP_TOKEN;
    const { seed } = await import("../../src/lib/seed.js");
    await seed();
    await seed();
    const users = await testDb.select().from(schema.users);
    expect(users).toHaveLength(7);
  });

  test("auto-generates one bootstrap token when api_tokens is empty", async () => {
    delete process.env.BOOTSTRAP_TOKEN;
    const { seed } = await import("../../src/lib/seed.js");
    await seed();

    const tokens = await testDb.select().from(schema.apiTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe("bootstrap");
    expect(tokens[0]!.scopes).toEqual(["admin"]);

    // Second run should not add another token.
    await seed();
    const after = await testDb.select().from(schema.apiTokens);
    expect(after).toHaveLength(1);
  });

  test("explicit BOOTSTRAP_TOKEN env wins (registered, not regenerated)", async () => {
    process.env.BOOTSTRAP_TOKEN = "sw_TESTBOOTSTRAPTOKEN0123456789ABCDEFGH";
    const { seed } = await import("../../src/lib/seed.js");
    await seed();

    const tokens = await testDb.select().from(schema.apiTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token_prefix).toBe("sw_TESTBOO");

    // Second run with same env value: still one token.
    await seed();
    const after = await testDb.select().from(schema.apiTokens);
    expect(after).toHaveLength(1);

    delete process.env.BOOTSTRAP_TOKEN;
  });
});
