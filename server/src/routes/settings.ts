// system_settings — singleton key/value store for runtime-tunable globals.
//
// We keep this small on purpose: the only knob today is
// stale_in_progress_days, used by /v1/projects/:key/stats. Adding a new key
// is a deliberate change in three places (drizzle table never changes; just
// the SystemSettingKey enum, the response shape in shared, and a default
// here). Frontend UI is "Settings → System" once we have more than one knob.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  SystemSettings, UpdateSystemSettings,
  DEFAULT_STALE_IN_PROGRESS_DAYS, DEFAULT_BOARD_CLOSED_WINDOW_DAYS,
  DEFAULT_LLM_OBS_USD_PER_KWH, DEFAULT_LLM_OBS_RETENTION_DAYS,
  type ClosedWindowDays,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { assertInstanceAdmin } from "../lib/authz.js";
import { errorResponses, okJson, checkScope } from "./_helpers.js";

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
const SETTING_DEFAULTS = {
  stale_in_progress_days: DEFAULT_STALE_IN_PROGRESS_DAYS,
  board_closed_window_days: DEFAULT_BOARD_CLOSED_WINDOW_DAYS,
  llm_obs_usd_per_kwh: DEFAULT_LLM_OBS_USD_PER_KWH,
  llm_obs_retention_days: DEFAULT_LLM_OBS_RETENTION_DAYS,
} as const;

type StoredSettings = {
  stale_in_progress_days: number;
  board_closed_window_days: ClosedWindowDays;
  llm_obs_usd_per_kwh: number;
  llm_obs_retention_days: number;
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
    board_closed_window_days: get<ClosedWindowDays>(
      "board_closed_window_days",
      SETTING_DEFAULTS.board_closed_window_days,
    ),
    llm_obs_usd_per_kwh: get("llm_obs_usd_per_kwh", SETTING_DEFAULTS.llm_obs_usd_per_kwh),
    llm_obs_retention_days: get("llm_obs_retention_days", SETTING_DEFAULTS.llm_obs_retention_days),
    updated_at: latest,
  };
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/settings", requireAuth);

  app.openapi(get, (async (c: any) => {
    return c.json(await readSettings(), 200);
  }) as any);

  // PATCH writes individual keys via upsert. Admin-only — these affect
  // global behavior (stale threshold flips counts on every dashboard).
  // Scope is checked in-handler (the `scope()` middleware form breaks
  // openapi's c.req.valid binding — see Phase 1.6 pattern note).
  app.openapi(patch, (async (c: any) => {
    checkScope(c, "admin");
    assertInstanceAdmin(c.get("auth").user, "settings");
    const body = c.req.valid("json");
    const nowIso = new Date().toISOString();

    const writes: Array<{ key: string; value: unknown }> = [];
    if (body.stale_in_progress_days !== undefined) {
      writes.push({ key: "stale_in_progress_days", value: body.stale_in_progress_days });
    }
    if (body.board_closed_window_days !== undefined) {
      writes.push({ key: "board_closed_window_days", value: body.board_closed_window_days });
    }
    if (body.llm_obs_usd_per_kwh !== undefined) {
      writes.push({ key: "llm_obs_usd_per_kwh", value: body.llm_obs_usd_per_kwh });
    }
    if (body.llm_obs_retention_days !== undefined) {
      writes.push({ key: "llm_obs_retention_days", value: body.llm_obs_retention_days });
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
