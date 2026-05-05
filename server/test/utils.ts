// Test isolation: run a function inside a transaction that always rolls back.
// Each test gets a clean slate without truncating tables between runs.
//
// Usage:
//   import { withTx } from "../utils";
//   test("creates a project", async () => {
//     await withTx(async (tx) => {
//       const [p] = await tx.insert(schema.projects).values({...}).returning();
//       expect(p.key).toBe("FOO");
//     });
//   });
import { testDb } from "./db.js";

class RollbackError extends Error {
  constructor() { super("__test_rollback__"); }
}

export async function withTx<T>(
  fn: (tx: Parameters<Parameters<typeof testDb.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  let result: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      result = await fn(tx);
      throw new RollbackError();
    });
  } catch (err) {
    if (err instanceof RollbackError) return result as T;
    throw err;
  }
  return result as T;
}
