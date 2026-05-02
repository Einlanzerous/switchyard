// Typed API client. Phase 2 generates `./api.types.ts` from the server's
// openapi.yaml via `openapi-typescript` and wires it into openapi-fetch:
//
//   bun run --cwd ../server openapi:gen        # writes ../openapi.yaml
//   bunx openapi-typescript ../openapi.yaml -o ./api.types.ts
//
// Then:
//
//   import createClient from "openapi-fetch";
//   import type { paths } from "./api.types";
//   export const api = createClient<paths>({ baseUrl: "/" });
//
// For now: a thin fetch wrapper that the placeholder home view uses.
export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
