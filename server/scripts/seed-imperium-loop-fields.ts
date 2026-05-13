// Idempotent seed for the custom fields the imperium-loop pipeline reads
// from and writes to tickets. Run once after the schema migration lands,
// then again whenever the field set changes.
//
//   DATABASE_URL=postgres://...:5432/switchyard \
//     bun server/scripts/seed-imperium-loop-fields.ts
//
// What it does: ensures every row below exists (matched by `(project_id,
// key)`). Existing rows are left alone — an operator's visibility-flag
// tweaks survive re-runs. Adding a new field here is the canonical way
// to ship a new declared field for the pipeline.
//
// Drift concern: the `mode` enum and `template` enum below duplicate
// values that live in the imperium-loop pipeline code (Cogitation Engine
// normalizer; servo-signal/scaffold.go's scaffoldTemplates). Keep them
// in lockstep at deploy time, or treat code-as-truth and update this
// list when the pipeline gains a new value. The DB layer doesn't
// validate writes against options.values — so a stale list breaks the
// UI, not the underlying data.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

type FieldType = "text" | "number" | "boolean" | "url" | "select";

type FieldSeed = {
  // Either a project key (for per-project) or null for global.
  project_key: string | null;
  key: string;
  label: string;
  type: FieldType;
  options?: { values: string[] };
  show_on_card?: boolean;
  show_on_create_form?: boolean;
  show_on_filter_bar?: boolean;
};

// The set comes from imperium-loop's current consumer surface. Comments
// in SWY-39 enumerate each field's pipeline-side use.
const FIELDS: FieldSeed[] = [
  // ─── global ──────────────────────────────────────────────────────────────
  {
    project_key: null, key: "repo_url", label: "Repo URL", type: "url",
    show_on_card: true, show_on_create_form: true, show_on_filter_bar: true,
  },
  {
    project_key: null, key: "pr_url", label: "PR URL", type: "url",
    show_on_card: true, show_on_filter_bar: true,
  },
  {
    project_key: null, key: "branch_name", label: "Branch", type: "text",
    show_on_card: true,
  },
  {
    project_key: null, key: "mode", label: "Mode", type: "select",
    options: { values: ["modify", "scaffold", "greenfield"] },
    show_on_card: true, show_on_create_form: true, show_on_filter_bar: true,
  },
  {
    project_key: null, key: "test_cmd", label: "Test command", type: "text",
    show_on_create_form: true,
  },
  // Machine-only — pipeline reads/writes; not user-facing.
  { project_key: null, key: "discord_thread_id", label: "Discord thread ID", type: "text" },
  { project_key: null, key: "n8n_execution_id", label: "n8n execution ID", type: "text" },
  {
    project_key: null, key: "refinement_attempts", label: "Refinement attempts", type: "number",
    show_on_card: true,
  },
  {
    project_key: null, key: "high_review_verdict", label: "High review verdict", type: "select",
    options: { values: ["approved", "rejected", "skipped"] },
    show_on_card: true,
  },

  // ─── per-project (scaffold) ──────────────────────────────────────────────
  // Lives under the project that will host scaffold work. Adjust
  // `project_key` if the canonical project for scaffold tickets is
  // different from "SWY".
  {
    project_key: "SWY", key: "template", label: "Template", type: "select",
    options: { values: ["vue", "go", "node"] },
    show_on_create_form: true,
  },
  {
    project_key: "SWY", key: "project_name", label: "Project name", type: "text",
    show_on_create_form: true,
  },
];

async function ensureField(seed: FieldSeed): Promise<void> {
  let project_id: string | null = null;
  if (seed.project_key) {
    const [p] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.key, seed.project_key))
      .limit(1);
    if (!p) {
      console.warn(
        `[imperium-fields] project "${seed.project_key}" not found; skipping field "${seed.key}"`,
      );
      return;
    }
    project_id = p.id;
  }

  // Lookup matches the partial-index uniqueness: separate paths for
  // (project_id IS NULL, key) and (project_id = $1, key).
  const where = project_id === null
    ? and(isNull(schema.customFields.project_id), eq(schema.customFields.key, seed.key))
    : and(eq(schema.customFields.project_id, project_id), eq(schema.customFields.key, seed.key));

  const [existing] = await db.select({ id: schema.customFields.id })
    .from(schema.customFields).where(where).limit(1);

  if (existing) return; // leave operator tweaks alone

  await db.insert(schema.customFields).values({
    project_id,
    key: seed.key,
    label: seed.label,
    type: seed.type,
    options: (seed.options ?? null) as any,
    show_on_card: seed.show_on_card ?? false,
    show_on_create_form: seed.show_on_create_form ?? false,
    show_on_filter_bar: seed.show_on_filter_bar ?? false,
  });
  console.log(`[imperium-fields] created ${seed.project_key ?? "(global)"}/${seed.key}`);
}

async function main() {
  for (const f of FIELDS) await ensureField(f);
  console.log("[imperium-fields] done");
  void sql;
}

try {
  await main();
} finally {
  await client.end();
}
