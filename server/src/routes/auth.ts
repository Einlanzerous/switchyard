// Cloudflare Access SSO exchange (SWY-161).
//
// Auth model differs from the rest of the API: the caller has no bearer token
// yet — the signed Access JWT injected by the Cloudflare tunnel IS the auth.
// `requireAuth` is intentionally NOT mounted on this path (same pattern as the
// GitHub webhook receiver in external.ts).

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { SsoLoginResponse } from "@switchyard/shared";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import { cfAccessConfig, verifyCfAccessJwt } from "../lib/cfAccess.js";
import { generateApiToken } from "../lib/id.js";
import { mapUser } from "../lib/mappers.js";
import { ssoDisabled, ssoNoAccount, unauthorized } from "../errors.js";
import { errorResponses, okJson } from "./_helpers.js";

const tag = "Auth";

// Name shown for SSO-minted tokens on the tokens settings page. A fresh token
// is minted per SSO login (plaintext is unrecoverable from the stored hash);
// these are not auto-revoked so signing in on one device doesn't kill others.
export const SSO_TOKEN_NAME = "Cloudflare SSO";

const ssoCloudflare = createRoute({
  method: "post",
  path: "/v1/auth/sso/cloudflare",
  tags: [tag],
  summary: "Exchange a Cloudflare Access JWT (Cf-Access-Jwt-Assertion header) for an API token",
  responses: { ...okJson(SsoLoginResponse), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(ssoCloudflare, (async (c: any) => {
    const cfg = cfAccessConfig();
    if (!cfg) throw ssoDisabled();
    const jwt = c.req.header("cf-access-jwt-assertion");
    if (!jwt) throw ssoDisabled("Cf-Access-Jwt-Assertion header missing");

    let email: string;
    try {
      email = (await verifyCfAccessJwt(jwt, cfg)).email.toLowerCase();
    } catch {
      throw unauthorized("invalid Cloudflare Access token");
    }

    const [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.email, email), isNull(schema.users.deleted_at)))
      .limit(1);
    if (!user) throw ssoNoAccount(email);

    const { token, hash, prefix } = generateApiToken();
    await db.insert(schema.apiTokens).values({
      user_id: user.id,
      name: SSO_TOKEN_NAME,
      kind: "personal",
      hashed_token: hash,
      token_prefix: prefix,
      scopes: ["admin"],
    });

    return c.json({ token, user: mapUser(user) }, 200);
  }) as any);
}
