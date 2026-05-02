// Dump the live OpenAPI document to ../openapi.yaml.
// Reuses the running app's route registry, so the YAML stays in sync with the routes.
import { OpenAPIHono } from "@hono/zod-openapi";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { mountRoutes } from "../routes/index.js";

const app = new OpenAPIHono();
mountRoutes(app);

const doc = app.getOpenAPIDocument({
  openapi: "3.0.0",
  info: {
    title: "switchyard",
    version: "0.0.0",
    description:
      "Self-hosted ticketing API. Agent-friendly: cursor pagination, idempotency keys, structured errors.",
  },
  servers: [{ url: "http://localhost:4002" }],
});

const out = resolve(import.meta.dir, "../../../openapi.yaml");
writeFileSync(out, stringify(doc));
console.log(`[openapi] wrote ${out}`);
