-- =============================================================================
-- Migration 0010: Phase 4 PR 8 -- discovery_feed admin_audit_entity_type value
--
-- Same situation as migration 0008 (ingestion_job): PR 8 introduces a new
-- admin-managed entity (discovery_feeds, migration 0011) whose create/
-- update/enable/disable actions need to be audit-logged, and
-- admin_audit_log has no entity_type value for it yet.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as a
-- statement that reads/writes using the new value (PostgreSQL restriction
-- on enum value visibility mid-transaction), so this migration contains
-- ONLY this one statement, deliberately -- consistent with migration 0008
-- and every other enum-value addition in this project.
-- =============================================================================

ALTER TYPE "admin_audit_entity_type" ADD VALUE 'discovery_feed';
