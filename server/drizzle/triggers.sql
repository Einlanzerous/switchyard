-- Custom SQL applied after the schema migration.
-- These enforce cross-row invariants that Drizzle's CHECK constraints cannot express.
-- The migrate.ts runner applies this file once after the generated drizzle migrations.

-- ─── Epic hierarchy guard ────────────────────────────────────────────────────
-- Rules:
--   - epics cannot have a parent (no epic-of-epic for now)
--   - non-epic tickets may have a parent only if that parent is type='epic' and not soft-deleted
CREATE OR REPLACE FUNCTION enforce_ticket_hierarchy() RETURNS trigger AS $$
DECLARE
  parent_type ticket_type;
  parent_deleted timestamptz;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.type = 'epic' THEN
    RAISE EXCEPTION 'epics cannot have a parent (parent_id must be NULL when type=epic)';
  END IF;

  SELECT type, deleted_at INTO parent_type, parent_deleted
    FROM tickets WHERE id = NEW.parent_id;

  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'parent ticket % does not exist', NEW.parent_id;
  END IF;

  IF parent_type <> 'epic' THEN
    RAISE EXCEPTION 'parent ticket must be type=epic, got %', parent_type;
  END IF;

  IF parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'parent ticket is soft-deleted';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tickets_hierarchy_check ON tickets;
CREATE TRIGGER tickets_hierarchy_check
  BEFORE INSERT OR UPDATE OF parent_id, type ON tickets
  FOR EACH ROW EXECUTE FUNCTION enforce_ticket_hierarchy();

-- ─── Resolution required only when status category = closed ─────────────────
-- This is a cross-table check (tickets.resolution depends on statuses.category),
-- so it lives as a trigger rather than a CHECK constraint.
CREATE OR REPLACE FUNCTION enforce_resolution_on_close() RETURNS trigger AS $$
DECLARE
  status_cat status_category;
BEGIN
  SELECT category INTO status_cat FROM statuses WHERE id = NEW.status_id;

  IF status_cat IS NULL THEN
    RAISE EXCEPTION 'status_id % does not exist', NEW.status_id;
  END IF;

  IF status_cat = 'closed' AND NEW.resolution IS NULL THEN
    RAISE EXCEPTION 'resolution is required when transitioning to a closed status';
  END IF;

  IF status_cat <> 'closed' AND NEW.resolution IS NOT NULL THEN
    RAISE EXCEPTION 'resolution must be NULL when status category is %', status_cat;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tickets_resolution_check ON tickets;
CREATE TRIGGER tickets_resolution_check
  BEFORE INSERT OR UPDATE OF status_id, resolution ON tickets
  FOR EACH ROW EXECUTE FUNCTION enforce_resolution_on_close();

-- ─── updated_at auto-bump ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bump_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'updated_at' AND table_schema = current_schema()
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS bump_updated_at ON %I', t);
    EXECUTE format('CREATE TRIGGER bump_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_updated_at()', t);
  END LOOP;
END $$;

-- ─── Backfill tickets.position ──────────────────────────────────────────────
-- New tickets get an explicit position assigned in the application layer
-- (epoch_ms at create time). Existing tickets pre-dating the column have
-- NULL — backfill them to epoch_ms(updated_at) so the default sort
-- (position DESC NULLS LAST, updated_at DESC) keeps the prior date-desc order
-- without anyone having to manually reorder. Idempotent: only touches NULLs.
UPDATE tickets
   SET position = EXTRACT(EPOCH FROM updated_at) * 1000
 WHERE position IS NULL;

-- ─── LLM observability (SWY-48 / Phase 5.1) ─────────────────────────────────
-- model_pricing periods must not overlap for any (model, provider) pair,
-- or the llm_observations_with_cost view would multiply observation rows
-- across overlapping pricing periods. Postgres tstzrange + EXCLUDE handles
-- this declaratively. btree_gist is needed for the equality piece.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'model_pricing_no_overlap'
  ) THEN
    ALTER TABLE model_pricing
      ADD CONSTRAINT model_pricing_no_overlap
      EXCLUDE USING gist (
        model WITH =,
        provider WITH =,
        tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
      );
  END IF;
END $$;

-- Cost-on-the-fly view. Joins each observation to the model_pricing row
-- whose [effective_from, effective_to) range contains occurred_at. Local
-- models seeded with zero rates resolve to cost_usd = 0 without special-
-- casing. NULL pricing (no matching row) yields NULL cost_usd, which the
-- UI surfaces as "unpriced" so the gap is visible.
CREATE OR REPLACE VIEW llm_observations_with_cost AS
SELECT
  o.*,
  p.input_usd_per_mtok,
  p.output_usd_per_mtok,
  p.cache_creation_multiplier,
  p.cache_read_multiplier,
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE (
      (o.input_tokens / 1000000.0) * p.input_usd_per_mtok
      + (o.output_tokens / 1000000.0) * p.output_usd_per_mtok
      + (COALESCE(o.cache_creation_input_tokens, 0) / 1000000.0)
          * p.input_usd_per_mtok * p.cache_creation_multiplier
      + (COALESCE(o.cache_read_input_tokens, 0) / 1000000.0)
          * p.input_usd_per_mtok * p.cache_read_multiplier
    )
  END AS cost_usd
FROM llm_observations o
LEFT JOIN model_pricing p
  ON p.model = o.model
  AND p.provider = o.provider
  AND o.occurred_at >= p.effective_from
  AND (p.effective_to IS NULL OR o.occurred_at < p.effective_to);

COMMENT ON VIEW llm_observations_with_cost IS
  'Observations joined to point-in-time pricing. cost_usd is NULL when no pricing row covers occurred_at.';
