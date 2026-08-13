-- =============================================================================
-- Migration 0001: Audit integrity for the two status-history ledgers
--
-- Three concerns handled here, all at the database layer (not just app code):
--   1. Immutability: history rows can never be UPDATEd or DELETEd, by anyone
--      connecting as app_role, and a trigger blocks it even for roles that
--      bypass grants (e.g. a future admin tool connecting as a broader role).
--   2. Auto-sync: claims.current_investigation_status / current_development_
--      outcome are updated automatically whenever a new history row is
--      inserted, so the "denormalized cache" can never drift from the
--      ledger it caches.
--   3. Unified read view: claim_status_timeline UNIONs both typed ledgers
--      for chronological display, without weakening the per-axis enum
--      typing on the underlying tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Immutability triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_status_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Status history rows are append-only and cannot be updated or deleted (table: %, attempted op: %)',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inv_status_history_immutable
  BEFORE UPDATE OR DELETE ON claim_investigation_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();

CREATE TRIGGER trg_dev_outcome_history_immutable
  BEFORE UPDATE OR DELETE ON claim_development_outcome_history
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();

-- ---------------------------------------------------------------------------
-- 2. Auto-sync triggers: keep claims.current_* in lockstep with the ledgers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_current_investigation_status()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE claims
  SET current_investigation_status = NEW.new_status,
      current_investigation_status_since = NEW.changed_at
  WHERE id = NEW.claim_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_current_investigation_status
  AFTER INSERT ON claim_investigation_status_history
  FOR EACH ROW EXECUTE FUNCTION sync_current_investigation_status();

CREATE OR REPLACE FUNCTION sync_current_development_outcome()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE claims
  SET current_development_outcome = NEW.new_outcome,
      current_development_outcome_since = NEW.changed_at
  WHERE id = NEW.claim_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_current_development_outcome
  AFTER INSERT ON claim_development_outcome_history
  FOR EACH ROW EXECUTE FUNCTION sync_current_development_outcome();

-- ---------------------------------------------------------------------------
-- 3. Combined read-only timeline view
-- ---------------------------------------------------------------------------

CREATE VIEW claim_status_timeline AS
SELECT
  id AS transition_id,
  claim_id,
  'investigation'::text AS axis,
  previous_status::text AS previous_value,
  new_status::text AS new_value,
  changed_at,
  reason,
  confidence,
  initiated_by,
  ai_result_id,
  admin_decision_id
FROM claim_investigation_status_history

UNION ALL

SELECT
  id AS transition_id,
  claim_id,
  'development_outcome'::text AS axis,
  previous_outcome::text AS previous_value,
  new_outcome::text AS new_value,
  changed_at,
  reason,
  confidence,
  initiated_by,
  ai_result_id,
  admin_decision_id
FROM claim_development_outcome_history;

-- ---------------------------------------------------------------------------
-- 4. Least-privilege grants for the runtime application role
--
-- app_role gets SELECT + INSERT on the two ledgers (never UPDATE/DELETE —
-- the trigger above is defense-in-depth, this grant is the primary
-- control). Normal operational tables get full CRUD since they don't carry
-- the same historical-integrity requirement.
--
-- Reconciliation note (added during post-Phase-3 architecture review --
-- see docs/architecture.md "Migration history reconciliation"): on the
-- staging database, app_role/admin_role were originally created by a
-- one-off manual bootstrap step that predated this migration history and
-- was never captured as a repo-controlled migration. That left a fresh
-- install broken -- this GRANT would fail with "role app_role does not
-- exist". The block below makes role creation idempotent and
-- repo-controlled. It is a no-op on staging (role already exists there)
-- and creates the role NOLOGIN (no password) on a fresh install --
-- granting LOGIN + a real password is a separate, environment-driven step
-- (see scripts/setup-db-roles.sql), never a value committed here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
  -- CONNECT is granted on whatever database this migration is actually
  -- running against (current_database()), not a hardcoded name -- Supabase
  -- projects are named "postgres", local setups often use "gta6_intel".
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_role', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO app_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects,
  topics,
  admin_users,
  source_types,
  source_item_types,
  sources,
  source_items,
  source_relationships,
  claims,
  claim_topics,
  claim_relationships,
  claim_sources,
  evidence,
  claim_evidence,
  ai_jobs,
  ai_results,
  admin_decisions,
  investigation_transition_evidence,
  development_transition_evidence
TO app_role;

-- Append-only: INSERT and SELECT only. No UPDATE, no DELETE.
GRANT SELECT, INSERT ON
  claim_investigation_status_history,
  claim_development_outcome_history
TO app_role;

-- Read-only combined view
GRANT SELECT ON claim_status_timeline TO app_role;
