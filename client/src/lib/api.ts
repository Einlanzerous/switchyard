// Typed API client. Regenerate types after server route changes:
//
//   bun run api:gen        # from repo root
//
// This rebuilds ../openapi.yaml from the server's live route registry, then
// runs openapi-typescript to produce ./api.types.ts (which is committed for
// PR diff visibility).
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./api.types.js";

const TOKEN_KEY = "switchyard.token";

export function getStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch { /* ignore — non-browser env or storage disabled */ }
}

const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = getStoredToken();
    if (token && !request.headers.has("Authorization")) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return request;
  },
};

export const api = createClient<paths>({ baseUrl: "/" });
api.use(authMiddleware);

export type Api = typeof api;

// Tiny guard for queryFn / mutationFn callers. openapi-fetch normally
// returns either { data, error: undefined } or { data: undefined, error };
// in rare failure modes (network drop mid-stream, body parse failure on a
// 5xx HTML page) BOTH come back undefined. Without this guard the queryFn
// silently `return undefined`, which TanStack Query rejects with
// "Query data cannot be undefined" — useless for diagnosing the real
// failure. Routing all empty results through here gives us a clear throw.
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) throw result.error;
  if (result.data === undefined) {
    throw new Error("empty response from API");
  }
  return result.data;
}
