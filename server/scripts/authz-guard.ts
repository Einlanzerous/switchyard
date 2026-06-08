// Phase 6 authz guard (SWY-96 / 6.1.0) — ENFORCING.
//
//   bun server/scripts/authz-guard.ts
//
// Guards BOTH dimensions of the Phase 6 access model at the route layer:
//
//   READS (6.1.x) — flags route files that query the project-scoped tables
//   (`tickets`, `projects`, `boards`) without referencing any `lib/authz.ts`
//   helper. A read of these tables should route through `visibleProjectFilter`
//   (lists) or `assertProjectReadable` / `canSeeProject` (detail).
//
//   WRITES (6.2 / SWY-102) — flags route files that mutate a project-scoped or
//   admin table (insert/update/delete) without referencing a write gate
//   (`assertProjectRole` for project role, `assertInstanceAdmin` for instance
//   surfaces). A write to a member's non-project resource must 403.
//
// It was ADVISORY through 6.1.0–6.1.4; 6.1.5 closed the read gaps and flipped it
// to ENFORCING; 6.2 added the write dimension. It runs in
// .github/workflows/ci.yml, so a new unscoped read OR write handler fails the
// build. A file that legitimately touches these tables outside the project model
// (self-scoped notification hydration, owner-scoped saved views, audit-event
// writes) satisfies the guard by referencing a helper in the relevant list, or
// by living on a table that isn't tracked here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENFORCE = true;

const ROUTES_DIR = join(import.meta.dir, "..", "src", "routes");

// READ shape: `.from(schema.<table>)` is what every list/detail handler uses.
const READ_TABLES = ["tickets", "projects", "boards"] as const;
const READ_HELPERS = [
  "visibleProjectFilter",
  "assertProjectReadable",
  "canSeeProject",
  "visibleProjectIds",
  "hasInstanceWideAccess",
  "assertInstanceAdmin",
  "visibleUserIds",
] as const;

// WRITE shapes: `.insert|update|delete(schema.<table>)` on a table whose writes
// must be role/instance gated. Self-scoped tables (savedViews, notifications,
// apiTokens, events, projectCounters, ticketLabels, boardProjects, …) are
// intentionally absent — their handlers gate by ownership or are pure audit.
const WRITE_TABLES = [
  "tickets", "comments", "attachments", "statuses", "statusTransitions",
  "ticketTemplates", "ticketLinks", "ticketExternalRefs", "projects",
  "customFields", "rules", "targets", "webhookSubscriptions", "boards",
  "labels", "users",
] as const;
const WRITE_VERBS = ["insert", "update", "delete"] as const;
const WRITE_HELPERS = ["assertProjectRole", "assertInstanceAdmin"] as const;

type Finding = { file: string; kind: "read" | "write"; tables: string[] };

const findings: Finding[] = [];

for (const entry of readdirSync(ROUTES_DIR)) {
  if (!entry.endsWith(".ts") || entry === "_helpers.ts") continue;
  const src = readFileSync(join(ROUTES_DIR, entry), "utf8");

  const readHit = READ_TABLES.filter((t) => src.includes(`.from(schema.${t})`));
  if (readHit.length > 0 && !READ_HELPERS.some((h) => src.includes(h))) {
    findings.push({ file: entry, kind: "read", tables: readHit });
  }

  const writeHit = WRITE_TABLES.filter((t) =>
    WRITE_VERBS.some((v) => src.includes(`.${v}(schema.${t})`)),
  );
  if (writeHit.length > 0 && !WRITE_HELPERS.some((h) => src.includes(h))) {
    findings.push({ file: entry, kind: "write", tables: writeHit });
  }
}

const banner = "─".repeat(72);
console.log(banner);
console.log(`authz-guard — ${ENFORCE ? "ENFORCING" : "ADVISORY"} (Phase 6 / SWY-96+102)`);
console.log(banner);

if (findings.length === 0) {
  console.log("✓ every handler touching scoped tables references the right authz gate (reads + writes).");
  process.exit(0);
}

console.log(`${findings.length} unscoped route finding(s):\n`);
for (const f of findings) {
  const gate = f.kind === "read" ? "read gate" : "write gate";
  console.log(`  • [${f.kind}] ${f.file}  (${f.tables.join(", ")}) — missing ${gate}`);
}
console.log(
  `\nSee docs/permissions.md. ${
    ENFORCE
      ? "Failing — wire assertProjectReadable/visibleProjectFilter (reads) or assertProjectRole/assertInstanceAdmin (writes)."
      : "Advisory only — not a gate yet."
  }`,
);

process.exit(ENFORCE ? 1 : 0);
