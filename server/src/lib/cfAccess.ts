// Cloudflare Access SSO verification (SWY-161).
//
// When switchyard is served through a Cloudflare tunnel with Access in front,
// every proxied request carries a signed JWT in the `Cf-Access-Jwt-Assertion`
// header. Verifying that JWT (signature against the team's JWKS + aud/iss/exp)
// proves the caller passed Cloudflare's identity check, so we can trust the
// `email` claim and mint a session token without a second login.
//
// The JWKS resolver and config are both injectable so tests can verify against
// a locally-generated key instead of reaching out to Cloudflare, and so a test
// can toggle the feature without fighting env.ts (which parses once at import).

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { env } from "../env.js";

export type CfAccessConfig = { teamDomain: string; aud: string };
export type CfAccessClaims = { email: string; sub?: string };

// undefined = read from env; null or a value = explicit test override.
let configOverride: CfAccessConfig | null | undefined;

export function setCfAccessConfigForTests(cfg: CfAccessConfig | null | undefined): void {
  configOverride = cfg;
  // A config change may point at a different team domain, so drop the cached
  // remote resolver too.
  remoteResolver = null;
  remoteResolverDomain = null;
}

// Returns the active config, or null when the feature is disabled (either env
// var missing). Tests can force either state via setCfAccessConfigForTests.
export function cfAccessConfig(): CfAccessConfig | null {
  if (configOverride !== undefined) return configOverride;
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null;
  return { teamDomain: env.CF_ACCESS_TEAM_DOMAIN, aud: env.CF_ACCESS_AUD };
}

let keyResolverOverride: JWTVerifyGetKey | null = null;

export function setCfAccessKeyResolverForTests(resolver: JWTVerifyGetKey | null): void {
  keyResolverOverride = resolver;
}

// Cache the remote JWKS resolver per team domain. `createRemoteJWKSet` handles
// key fetching, caching, rotation and cooldown internally.
let remoteResolver: JWTVerifyGetKey | null = null;
let remoteResolverDomain: string | null = null;

function resolver(cfg: CfAccessConfig): JWTVerifyGetKey {
  if (keyResolverOverride) return keyResolverOverride;
  if (!remoteResolver || remoteResolverDomain !== cfg.teamDomain) {
    remoteResolver = createRemoteJWKSet(
      new URL(`https://${cfg.teamDomain}/cdn-cgi/access/certs`),
    );
    remoteResolverDomain = cfg.teamDomain;
  }
  return remoteResolver;
}

// Verifies the Access JWT and returns its identity claims. Throws (jose errors)
// on a bad signature / issuer / audience / expiry, and a plain Error when the
// `email` claim is missing or not a string. Callers map any throw to 401.
export async function verifyCfAccessJwt(
  jwt: string,
  cfg: CfAccessConfig,
): Promise<CfAccessClaims> {
  const { payload } = await jwtVerify(jwt, resolver(cfg), {
    issuer: `https://${cfg.teamDomain}`,
    audience: cfg.aud,
    algorithms: ["RS256"],
  });
  const email = payload.email;
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("Cloudflare Access token has no email claim");
  }
  return { email, sub: typeof payload.sub === "string" ? payload.sub : undefined };
}
