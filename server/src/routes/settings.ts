// system_settings — singleton key/value store for runtime-tunable globals.
//
// We keep this small on purpose: the only knob today is
// stale_in_progress_days, used by /v1/projects/:key/stats. Adding a new key
// is a deliberate change in three places (drizzle table never changes; just
// the SystemSettingKey enum, the response shape in shared, and a default
// here). Frontend UI is "Settings → System" once we have more than one knob.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import {
  SystemSettings, UpdateSystemSettings, DEFAULT_STALE_IN_PROGRESS_DAYS,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, scope, z } from "./_helpers.js";

const tag = "Settings";

const get = createRoute({
  method: "get", path: "/v1/settings", tags: [tag], summary: "Read system settings",
  responses: { ...okJson(SystemSettings), ...errorResponses },
});

const patch = createRoute({
  method: "patch", path: "/v1/settings", tags: [tag], summary: "Update system settings",
  request: { body: { content: { "application/json": { schema: UpdateSystemSettings } } } },
  responses: { ...okJson(SystemSettings), ...errorResponses },
});

// All settings keys + their defaults live here. The seeder writes these on
// first migrate; reads merge stored values over the defaults so a new key
// shipped after deploy is immediately readable without a manual migration.
export const SETTING_DEFAULTS = {
  stale_in_progress_days: DEFAULT_STALE_IN_PROGRESS_DAYS,
} as const;

type StoredSettings = {
  stale_in_progress_days: number;
  updated_at: string;
};

export async function readSettings(): Promise<StoredSettings> {
  const rows = await db.select().from(schema.systemSettings);
  const map = new Map<string, { value: unknown; updated_at: string }>();
  for (const r of rows) map.set(r.key, { value: r.value, updated_at: r.updated_at });

  const get = <T>(key: keyof typeof SETTING_DEFAULTS, fallback: T): T => {
    const row = map.get(key);
    if (!row) return fallback;
    return row.value as T;
  };
  // Pick the freshest updated_at across all rows so the UI can surface a
  // single "last changed" timestamp; default to epoch when no rows exist.
  const latest = rows.reduce<string>(
    (acc, r) => (r.updated_at > acc ? r.updated_at : acc),
    "1970-01-01T00:00:00.000Z"
  );

  return {
    stale_in_progress_days: get("stale_in_progress_days", SETTING_DEFAULTS.stale_in_progress_days),
    updated_at: latest,
  };
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/settings", requireAuth);

  app.openapi(get, (async (c: any) => {
    return c.json(await readSettings(), 200);
  }) as any);

  // PATCH writes individual keys via upsert. Admin-only — these affect
  // global behavior (stale threshold flips counts on every dashboard). We
  // don't accept partial-validation skips: zod has already run.
  app.openapi(patch, scope("admin"), (async (c: any) => {
    const body = c.req.valid("json");
    const nowIso = new Date().toISOString();

    const writes: Array<{ key: string; value: unknown }> = [];
    if (body.stale_in_progress_days !== undefined) {
      writes.push({ key: "stale_in_progress_days", value: body.stale_in_progress_days });
    }

    for (const w of writes) {
      await db
        .insert(schema.systemSettings)
        .values({ key: w.key, value: w.value, updated_at: nowIso })
        .onConflictDoUpdate({
          target: schema.systemSettings.key,
          set: { value: w.value, updated_at: nowIso },
        });
    }

    return c.json(await readSettings(), 200);
  }) as any);
}
