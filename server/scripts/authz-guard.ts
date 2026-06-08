// Phase 6 authz guard (SWY-96 / 6.1.0) — ENFORCING (flipped in 6.1.5 / SWY-101).
//
//   bun server/scripts/authz-guard.ts
//
// Flags route handlers that query the project-scoped tables (`tickets`,
// `projects`, `boards`) without referencing any `lib/authz.ts` helper. The idea:
// a handler reading these tables should route through `visibleProjectFilter`
// (list reads) or `assertProjectReadable` / `canSeeProject` (detail reads), so a
// `member` human can't see projects they don't belong to.
//
// It was ADVISORY through 6.1.0–6.1.4 while the read path was wired family by
// family. 6.1.5 (the admin-surface audit) closed the last gaps, so it now ENFORCES:
// it runs in .github/workflows/ci.yml and a new unscoped handler fails the build.
// A handler that legitimately touches these tables outside the project-scoped
// read model (e.g. self-scoped notification hydration) satisfies the guard by
// referencing any helper in AUTHZ_HELPERS.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENFORCE = true;

const ROUTES_DIR = join(import.meta.dir, "..", "src", "routes");

// `.from(schema.<table>)` is the read shape every list/detail handler uses.
const SCOPED_TABLES = ["tickets", "projects", "boards"] as const;
const AUTHZ_HELPERS = [
  "visibleProjectFilter",
  "assertProjectReadable",
  "canSeeProject",
  "visibleProjectIds",
  "hasInstanceWideAccess",
  "assertInstanceAdmin",
  "visibleUserIds",
] as const;

type Finding = { file: string; tables: string[] };

const findings: Finding[] = [];

for (const entry of readdirSync(ROUTES_DIR)) {
  if (!entry.endsWith(".ts") || entry === "_helpers.ts") continue;
  const src = readFileSync(join(ROUTES_DIR, entry), "utf8");

  const hit = SCOPED_TABLES.filter((t) => src.includes(`.from(schema.${t})`));
  if (hit.length === 0) continue;

  const usesAuthz = AUTHZ_HELPERS.some((h) => src.includes(h));
  if (!usesAuthz) findings.push({ file: entry, tables: hit });
}

const banner = "─".repeat(72);
console.log(banner);
console.log(`authz-guard — ${ENFORCE ? "ENFORCING" : "ADVISORY"} (Phase 6 / SWY-96)`);
console.log(banner);

if (findings.length === 0) {
  console.log("✓ every handler touching tickets/projects/boards references an authz helper.");
  process.exit(0);
}

console.log(`${findings.length} route file(s) query scoped tables without an authz helper:\n`);
for (const f of findings) {
  console.log(`  • ${f.file}  (queries: ${f.tables.join(", ")})`);
}
console.log(
  `\nSee docs/permissions.md. ${ENFORCE ? "Failing — wire the authz helpers." : "Advisory only — not a gate yet."}`,
);

process.exit(ENFORCE ? 1 : 0);
