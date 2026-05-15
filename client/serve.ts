import { file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(Bun.env.PORT ?? 4002);
const BACKEND_URL = Bun.env.BACKEND_URL ?? "http://switchyard:4002";
const DIST = join(import.meta.dir, "dist");

// ─── deploy-aware passthrough retries ────────────────────────────────────
//
// Backend container recreates take ~30s (best case) to ~120s (a slow
// migration or first-request warm-up). During that window the frontend's
// fetch to /v1/* throws (connection refused) or the backend's 503 surfaces
// as "backend_unreachable". For short bumps the user shouldn't have to see
// anything — we retry quietly and hand back the eventual success.
//
// Tuning:
// - Initial wait is 200ms so a normal-speed deploy completes within ~5
//   retries.
// - Hard cap is 15s — beyond that we give up and return a friendly 503
//   so the browser/agent can decide what to do (TanStack Query also has
//   its own retry pass on top of this).
// - Only idempotent retries by default (GET/HEAD/OPTIONS). POST/PATCH/
//   PUT/DELETE retry only when the failure was a connection refusal —
//   not a 5xx — because the request may already have side-effected.
const RETRY_WINDOW_MS = 15_000;
const RETRY_INTERVAL_MS = 200;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ProxyAttempt =
  | { kind: "ok"; response: Response }
  | { kind: "transient_5xx"; response: Response }
  | { kind: "connection_refused" };

async function attemptProxy(
  target: URL,
  init: RequestInit,
): Promise<ProxyAttempt> {
  try {
    const res = await fetch(target, init);
    // 502/503/504 are the bumps we care about — anything else is the real
    // backend response and we hand it back.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { kind: "transient_5xx", response: res };
    }
    return { kind: "ok", response: res };
  } catch {
    return { kind: "connection_refused" };
  }
}

async function proxyWithRetries(target: URL, init: RequestInit, method: string): Promise<Response> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  const isIdempotent = IDEMPOTENT_METHODS.has(method);
  let last: ProxyAttempt = { kind: "connection_refused" };

  while (Date.now() < deadline) {
    last = await attemptProxy(target, init);
    if (last.kind === "ok") return last.response;
    // 5xx on non-idempotent requests: don't retry — the side effect may
    // already have landed. Hand the response back unchanged.
    if (last.kind === "transient_5xx" && !isIdempotent) return last.response;
    await sleep(RETRY_INTERVAL_MS);
  }

  // Exhausted the window. Surface a deploy-aware 503 so the caller has a
  // clear signal (TanStack Query will retry once more, then surface to UI).
  if (last.kind === "transient_5xx") return last.response;
  return new Response(
    JSON.stringify({
      error: {
        code: "backend_unreachable",
        message: `switchyard backend not reachable after ${RETRY_WINDOW_MS / 1000}s (deploy in progress?)`,
      },
    }),
    { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
      const target = new URL(url.pathname + url.search, BACKEND_URL);
      const headers = new Headers(req.headers);
      headers.delete("host");
      return proxyWithRetries(
        target,
        {
          method: req.method,
          headers,
          body: req.body,
          // @ts-expect-error — Bun's fetch supports half-duplex streaming for request bodies.
          duplex: "half",
          redirect: "manual",
        },
        req.method,
      );
    }

    const safe = normalize(url.pathname).replace(/^\/+/, "");
    if (safe.includes("..")) {
      return new Response("not found", { status: 404 });
    }

    const target = file(join(DIST, safe || "index.html"));
    if (await target.exists()) {
      return new Response(target);
    }

    return new Response(file(join(DIST, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[switchyard-frontend] listening on :${PORT} (backend: ${BACKEND_URL})`);
