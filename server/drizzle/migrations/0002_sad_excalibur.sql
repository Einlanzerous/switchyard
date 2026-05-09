-- ─── Labels go global ──────────────────────────────────────────────────────
-- Drop the per-project FK + unique, dedupe by name across projects, and
-- promote (name) to the new uniqueness key. ticket_labels rows are repointed
-- to the kept label so no associations are lost.

-- Drop the project FK first so we can mutate label rows freely below.
ALTER TABLE "labels" DROP CONSTRAINT IF EXISTS "labels_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "labels_project_name_unique";
--> statement-breakpoint

-- Dedupe: for each name keep the oldest label, redirect ticket_labels to that
-- keeper (skipping rows that would create a duplicate (ticket_id,label_id)
-- pair after the redirect), then delete the loser labels and any orphan
-- ticket_labels that pointed at them.
WITH ranked AS (
  SELECT id, name,
         ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS rn
    FROM labels
),
keepers AS (SELECT id, name FROM ranked WHERE rn = 1),
losers  AS (
  SELECT r.id AS loser_id, k.id AS keeper_id
    FROM ranked r
    JOIN keepers k ON r.name = k.name AND r.rn > 1
)
UPDATE ticket_labels tl
   SET label_id = losers.keeper_id
  FROM losers
 WHERE tl.label_id = losers.loser_id
   AND NOT EXISTS (
     SELECT 1 FROM ticket_labels tl2
      WHERE tl2.ticket_id = tl.ticket_id
        AND tl2.label_id = losers.keeper_id
   );
--> statement-breakpoint

-- Anything that still points at a loser is now a would-be duplicate; drop it.
DELETE FROM ticket_labels
 WHERE label_id IN (
   SELECT r.id
     FROM (
       SELECT id, name,
              ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS rn
         FROM labels
     ) r
    WHERE r.rn > 1
 );
--> statement-breakpoint

DELETE FROM labels
 WHERE id IN (
   SELECT r.id
     FROM (
       SELECT id, name,
              ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS rn
         FROM labels
     ) r
    WHERE r.rn > 1
 );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "labels_name_unique" ON "labels" USING btree ("name");
--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN IF EXISTS "project_id";
