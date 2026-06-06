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

