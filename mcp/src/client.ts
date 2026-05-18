// openapi-fetch client wired to the switchyard REST API. Request/response
// shapes come from `api.types.ts` (generated from openapi.yaml), so when the
// REST surface evolves the HTTP plumbing stays correct automatically — only
// the *curated MCP tool layer* needs to be touched when we want to expose
// new behavior.

import createClient from "openapi-fetch";
import type { paths } from "./api.types.js";
import { loadEnv } from "./env.js";

let _client: ReturnType<typeof createClient<paths>> | null = null;

export function getClient() {
  if (_client) return _client;
  const env = loadEnv();
  _client = createClient<paths>({
    baseUrl: env.baseUrl,
    headers: {
      Authorization: `Bearer ${env.token}`,
    },
  });
  return _client;
}

// Test seam: drop the cached client so the next getClient() rebuilds it
// against current env / global fetch. Production code never calls this.
export function __resetClientForTests(): void {
  _client = null;
}
