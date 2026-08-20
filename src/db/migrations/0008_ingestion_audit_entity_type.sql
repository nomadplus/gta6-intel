-- =============================================================================
-- Migration 0008: Phase 4 PR 6 -- ingestion_job admin_audit_entity_type value
--
-- Closes a gap flagged during PR 4 planning (see src/db/mutations/ingestion.ts):
-- admin_audit_log had no entity_type value for ingestion job actions, so
-- job creation and confirmation went unaudited. This migration adds the
-- one missing enum value; PR 6's application-code changes (src/db/mutations/
-- ingestion.ts, src/db/mutations/shared.ts) are what actually start writing
-- audit_log rows using it.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as a
-- statement that reads/writes using the new value (PostgreSQL restriction
-- on enum value visibility mid-transaction), so this migration contains
-- ONLY this one statement, deliberately -- consistent with how every other
-- enum-value addition in this project has been kept isolated.
-- =============================================================================

ALTER TYPE "admin_audit_entity_type" ADD VALUE 'ingestion_job';
