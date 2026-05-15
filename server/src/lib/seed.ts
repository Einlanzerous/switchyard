// Idempotent seed: canonical users + bootstrap token + canonical labels.
// Called from migrate.ts after schema migrations and triggers are applied.
//
// Bootstrap rules (locked decision):
//   - If env.BOOTSTRAP_TOKEN is set, register that exact value as an admin
//     token attached to `magos` (idempotent — re-running is a no-op).
//   - Else, if `api_tokens` is empty, auto-generate one admin token, print
//     it once to stdout, and write it to ${UPLOAD_DIR}/.bootstrap-token
//     (one-shot file the user reads then deletes).
//   - Once any tokens exist and BOOTSTRAP_TOKEN is unset, the bootstrap path
//     is silent. No re-prompts.
import { eq, and } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { db, schema } from "../db.js";
import { env } from "../env.js";
import { generateApiToken, hashToken } from "./id.js";
import { DEFAULT_STALE_IN_PROGRESS_DAYS, DEFAULT_BOARD_CLOSED_WINDOW_DAYS } from "@switchyard/shared";
import { DEFAULT_BOARD_DELETED_KEY } from "./defaultBoard.js";

type CanonicalUser = {
  name: string;
  type: "human" | "agent";
  icon?: string;
};

type CanonicalLabel = {
  name: string;
  color: string;
};

export const RULES_ENGINE_USER_NAME = "rules-engine";

// Labels shipped with every install. New ones added here will appear on
// next migrate run; existing rows are never touched (so an admin's color
// tweak survives a redeploy).
const CANONICAL_LABELS: CanonicalLabel[] = [
  // Used by imperium-loop (and any other agent flow) to mark tickets the
  // user has explicitly green-lit for autonomous work. Rule editors can
  // target `ticket.labels[].name = "ready-for-agent"` to gate firings.
  { name: "ready-for-agent", color: "#10b981" },
];

const CANONICAL_USERS: CanonicalUser[] = [
  { name: "magos", type: "human" },
  { name: "claude", type: "agent" },
  { name: "n8n-cogitation", type: "agent" },
  { name: "n8n-vox-dictate", type: "agent" },
  { name: "servo-signal", type: "agent" },
  { name: "autosavant-bot", type: "agent" },
  // System actor for Phase 4 automation rules. Every action a rule runs
  // (create comment, set field, add label, …) is attributed to this user.
  // The rule dispatcher uses this id to skip events authored by rules, which
  // is how we prevent infinite-loop fan-out without tracking causation chains.
  { name: RULES_ENGINE_USER_NAME, type: "agent" },
];

export async function seed(): Promise<void> {
  const userIdsByName = await ensureUsers();
  await ensureBootstrapToken(userIdsByName.get("magos")!);
  await ensureDefaultSettings();
  await ensureLabels();
  await ensureDefaultBoard();
}

// Auto-create an "All projects" board on first boot. Populates it with
// every active, non-archived project, and flips `auto_include_all_projects`
// so the project lifecycle hooks keep it in sync. If the user later
// deletes the board, the delete handler stamps `default_board_deleted`
// in system_settings — we honor that here and never recreate it.
async function ensureDefaultBoard(): Promise<void> {
  const [existing] = await db
    .select({ id: schema.boards.id })
    .from(schema.boards)
    .where(eq(schema.boards.auto_include_all_projects, true))
    .limit(1);
  if (existing) return;

  const [deletedFlag] = await db
    .select({ value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, DEFAULT_BOARD_DELETED_KEY))
    .limit(1);
  if (deletedFlag?.value === true) return;

  const rows = await db.execute<{ id: string }>(
    /* sql */ `SELECT id FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL` as any,
  );
  const projectIds = ((rows as any).rows ?? rows) as Array<{ id: string }>;

  const [board] = await db
    .insert(schema.boards)
    .values({
      name: "All projects",
      layout: "kanban",
      auto_include_all_projects: true,
    })
    .returning({ id: schema.boards.id });
  if (!board) throw new Error("ensureDefaultBoard: insert returned nothing");

  if (projectIds.length > 0) {
    await db
      .insert(schema.boardProjects)
      .values(projectIds.map((p) => ({ board_id: board.id, project_id: p.id })));
  }
  console.log(`[seed] created default "All projects" board with ${projectIds.length} project(s)`);
}

async function ensureLabels(): Promise<void> {
  for (const l of CANONICAL_LABELS) {
    const [existing] = await db
      .select({ id: schema.labels.id })
      .from(schema.labels)
      .where(eq(schema.labels.name, l.name))
      .limit(1);
    if (existing) continue;
    await db.insert(schema.labels).values({ name: l.name, color: l.color });
    console.log(`[seed] created label: ${l.name}`);
  }
}

// Insert default values for any system_settings keys that don't have a row
// yet. Existing rows are left alone so an admin's runtime tweaks survive a
// redeploy. Adding a new key here is the canonical way to ship a new
// default — it'll only write on first boot post-update.
async function ensureDefaultSettings(): Promise<void> {
  const defaults = [
    { key: "stale_in_progress_days", value: DEFAULT_STALE_IN_PROGRESS_DAYS },
    { key: "board_closed_window_days", value: DEFAULT_BOARD_CLOSED_WINDOW_DAYS },
  ];
  for (const d of defaults) {
    const [existing] = await db
      .select({ key: schema.systemSettings.key })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, d.key))
      .limit(1);
    if (existing) continue;
    await db.insert(schema.systemSettings).values({ key: d.key, value: d.value });
    console.log(`[seed] default system_settings.${d.key} = ${JSON.stringify(d.value)}`);
  }
}

async function ensureUsers(): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const u of CANONICAL_USERS) {
    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.name, u.name))
      .limit(1);

    if (existing) {
      result.set(u.name, existing.id);
      continue;
    }

    const [created] = await db
      .insert(schema.users)
      .values({ name: u.name, type: u.type, icon: u.icon ?? null })
      .returning({ id: schema.users.id });

    if (!created) throw new Error(`failed to insert user ${u.name}`);
    result.set(u.name, created.id);
    console.log(`[seed] created user: ${u.name} (${u.type})`);
  }

  return result;
}

async function ensureBootstrapToken(magosId: string): Promise<void> {
  // Path A: explicit BOOTSTRAP_TOKEN env — register it (idempotent on hash).
  if (env.BOOTSTRAP_TOKEN) {
    const hash = hashToken(env.BOOTSTRAP_TOKEN);
    const [existing] = await db
      .select({ id: schema.apiTokens.id })
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.hashed_token, hash))
      .limit(1);

    if (existing) return;

    const prefix = env.BOOTSTRAP_TOKEN.slice(0, 10);
    await db.insert(schema.apiTokens).values({
      user_id: magosId,
      name: "bootstrap",
      hashed_token: hash,
      token_prefix: prefix,
      scopes: ["admin"],
    });
    console.log(`[seed] registered BOOTSTRAP_TOKEN (prefix=${prefix})`);
    return;
  }

  // Path B: auto-generate only when api_tokens is empty.
  const [{ count }] = (await db.execute<{ count: number }>(
    // count is bigint in pg; we just need >0 vs 0
    // drizzle typing for execute is weak — explicit cast
    // (the surrounding env-empty check is the only thing we care about)
    /* sql */ `SELECT count(*)::int AS count FROM api_tokens` as unknown as any
  )) as unknown as [{ count: number }];

  if (count > 0) return;

  const { token, hash, prefix } = generateApiToken();

  await db.insert(schema.apiTokens).values({
    user_id: magosId,
    name: "bootstrap",
    hashed_token: hash,
    token_prefix: prefix,
    scopes: ["admin"],
  });

  // Write to one-shot file inside the upload dir (already mounted as a volume).
  try {
    const path = resolve(env.UPLOAD_DIR, ".bootstrap-token");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, token + "\n", { mode: 0o600 });
    console.log(`[seed] bootstrap token written to ${path}`);
  } catch (err) {
    console.warn("[seed] could not write .bootstrap-token file:", err);
  }

  // Also surface to stdout with a banner so it's hard to miss in `docker logs`.
  const banner = "═".repeat(72);
  console.log(banner);
  console.log("  switchyard bootstrap token (shown ONCE — copy it now)");
  console.log(`  ${token}`);
  console.log("  Use it to mint real per-user tokens, then revoke this one.");
  console.log(banner);
}
