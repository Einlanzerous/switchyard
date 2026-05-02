import type { MiddlewareHandler } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "./db.js";
import { hashToken } from "./lib/id.js";
import { unauthorized, forbidden } from "./errors.js";
import type { ApiTokenScope } from "@switchyard/shared";

export type AuthContext = {
  user: typeof schema.users.$inferSelect;
  token: typeof schema.apiTokens.$inferSelect;
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

const BEARER = /^Bearer\s+(sw_[A-Z2-7]{32})$/;

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const match = BEARER.exec(header);
  if (!match) throw unauthorized();

  const hash = hashToken(match[1]!);

  const [row] = await db
    .select({
      token: schema.apiTokens,
      user: schema.users,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.apiTokens.user_id, schema.users.id))
    .where(
      and(
        eq(schema.apiTokens.hashed_token, hash),
        isNull(schema.apiTokens.revoked_at),
        isNull(schema.users.deleted_at)
      )
    )
    .limit(1);

  if (!row) throw unauthorized();

  // Best-effort last_used_at update — don't block the request on it.
  void db
    .update(schema.apiTokens)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(schema.apiTokens.id, row.token.id))
    .catch(() => {});

  c.set("auth", { user: row.user, token: row.token });
  await next();
};

export function requireScope(...scopes: ApiTokenScope[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw unauthorized();
    const granted = auth.token.scopes as ApiTokenScope[];
    if (granted.includes("admin")) return next();
    const ok = scopes.every((s) => granted.includes(s));
    if (!ok) throw forbidden(`requires scope(s): ${scopes.join(", ")}`);
    await next();
  };
}
