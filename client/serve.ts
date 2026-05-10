import { file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(Bun.env.PORT ?? 4002);
const BACKEND_URL = Bun.env.BACKEND_URL ?? "http://switchyard:4002";
const DIST = join(import.meta.dir, "dist");

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
      const target = new URL(url.pathname + url.search, BACKEND_URL);
      const headers = new Headers(req.headers);
      headers.delete("host");
      try {
        return await fetch(target, {
          method: req.method,
          headers,
          body: req.body,
          // @ts-expect-error — Bun's fetch supports half-duplex streaming for request bodies.
          duplex: "half",
          redirect: "manual",
        });
      } catch {
        // Backend unreachable (restarting, network blip). Match the API's error envelope.
        return new Response(
          JSON.stringify({
            error: { code: "backend_unreachable", message: "switchyard backend is not reachable" },
          }),
          { status: 502, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
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
