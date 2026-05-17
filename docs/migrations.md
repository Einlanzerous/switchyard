# Migration safety guidelines

Switchyard runs `bun src/lib/migrate.ts` as the first half of the container
entrypoint, then `exec`s the API server. Deploy downtime ≈ migrate duration
+ API boot time. Migrations that lock a populated table or do a synchronous
backfill turn a 30s deploy into a 2-minute one — and worse, a deploy that
fails mid-migration leaves the system in a half-applied state until
someone intervenes.

These rules exist to keep migrations fast, reversible, and forward-compatible
with the previous running container during a rollout.

## The five rules

1. **Additive only on hot tables.** New columns on `tickets`, `events`,
   `comments`, `projects`, `webhook_deliveries`, `rule_firings` must be
   nullable or carry a default. Never drop a column in the same release
   that stops writing to it — old container instances may still be running
   when the new schema lands.

2. **Destructive changes follow a two-PR ladder.** When a column needs to
   be removed:
   - PR 1: add the new column, backfill from the old (one-off script),
     switch all readers and writers to the new column. Old column is
     redundant but still present.
   - Wait one full release cycle.
   - PR 2: drop the old column.
   - Same pattern for renames (effectively "add new, copy, drop old") and
     for NOT-NULL tightening (use a CHECK first, fix violators, then
     promote).

3. **Backfills on populated tables run in batches.** A backfill that
   `UPDATE ... WHERE old_col IS NULL` locks the whole table for the
   duration. For anything larger than ~1000 rows, write a one-off
   `server/scripts/backfill-<thing>.ts` that loops in 500-row batches with
   a small sleep between, and run it manually before the migration that
   removes the column. The migration itself stays cheap.

4. **CHECK constraints with subqueries are forbidden.** Postgres takes an
   ACCESS EXCLUSIVE lock for the duration of `ALTER TABLE ADD CONSTRAINT`,
   and a subquery makes that duration unbounded. Use a trigger or
   application-level validation instead. (CHECK constraints on a single
   row's columns are fine — they're cheap to evaluate.)

5. **UNIQUE / regular indexes on populated tables use `CONCURRENTLY`.** A
   plain `CREATE INDEX` on a 50k-row table takes a write lock. Drizzle
   doesn't emit CONCURRENTLY by default, so for any index on a hot table
   either (a) accept the brief lock when the table is small and document
   it in the PR, or (b) add the index in a follow-up `raw SQL` migration
   that uses CONCURRENTLY. Note: CONCURRENTLY can't run inside a
   transaction, so it needs its own migration file.

## When a destructive change is unavoidable

Document the deviation in the PR description. Required fields:

- **Table affected** and approximate row count at deploy time.
- **Lock duration estimate** (you can measure on a copy of prod).
- **Deploy plan**: are you putting the system into maintenance, or
  accepting the lock window? Both are valid; the choice should be
  conscious.
- **Rollback plan**: if the migration fails mid-way, how do you recover?

## Audit of existing migrations

As of migration `0016_orange_james_howlett`, switchyard has 17 migrations.
The audit verdict per migration:

| File | Verdict | Notes |
|---|---|---|
| `0000_little_jane_foster` | Safe | Initial schema; no risk by definition. |
| `0001_new_reptil` | Safe | One additive ALTER. |
| `0002_sad_excalibur` | **Was risky, safe in hindsight** | Dropped `labels.project_id`, made labels global. Done while the table had < 50 rows; lock window was milliseconds. At scale this would need the two-PR ladder. |
| `0003_jazzy_jocasta` | Safe | Additive. |
| `0004_redundant_spencer_smythe` | Safe | Additive. |
| `0005_lying_the_leader` | Safe | Additive. |
| `0006_perfect_morg` | Safe | Additive. |
| `0007_complete_johnny_blaze` | Safe | `rules.project_id DROP NOT NULL` is a relaxing change — old schema is a strict subset of new, so old container code still works against the new schema. |
| `0008_flawless_gressill` | Safe | 5 ALTERs, all additive. |
| `0009_nappy_orphan` | Safe | One additive ALTER. |
| `0010_wandering_puppet_master` | Safe | Additive. |
| `0011_complex_martin_li` | Safe | Additive. |
| `0012_swift_ultragirl` | Safe | Additive. |
| `0013_first_edwin_jarvis` | Safe | 2 ALTERs, both additive. |
| `0014_ancient_mother_askani` | Safe | New `ticket_templates` table + additive `tickets.template_id` column. |
| `0015_outstanding_queen_noir` | Safe | New `ticket_aliases` + `boards.auto_include_all_projects` (with DEFAULT false). |
| `0016_orange_james_howlett` | Safe | One additive ALTER (`projects.repo_url`). |

**Net:** No outstanding remediation. The two destructive operations in
history (`0002`, `0007`) happened when the affected tables were either
empty or had a relaxing semantic; neither would have caused a real outage.

## Quick reference

When in doubt, ask:

- Is the operation **only adding things** (new column / new table / new
  index / new constraint that no existing row violates)? → Safe.
- Does the operation **remove or tighten** anything? → Two-PR ladder.
- Does the operation **touch a hot table with a backfill**? → Batch the
  backfill in a script first; keep the migration itself O(1) in DDL.
- Does the operation **add an index to a big table**? → Use CONCURRENTLY,
  separate migration file, no transaction wrapper.
