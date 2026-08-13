-- =============================================================================
-- Migration 0005: fix admin_role sequence grants
--
-- Bug found during staging verification: when admin_role was first created
-- (in a preliminary step before migration 0000 ran), it was granted
-- USAGE ON ALL SEQUENCES IN SCHEMA public. At that moment no tables --
-- and therefore no sequences -- existed yet. Postgres's "ALL SEQUENCES"
-- grant only covers sequences that exist at the instant the GRANT runs,
-- not ones created afterward. Every subsequent migration (0000-0004)
-- created tables with serial columns, and none of those sequences ever
-- received the grant. Net effect: admin_role could SELECT/INSERT/UPDATE/
-- DELETE on every table, but any INSERT relying on a serial default id
-- failed, because generating that default requires sequence USAGE.
--
-- This was caught by an actual admin mutation failing in the deployed
-- staging environment (creating a topic), not by local testing --
-- worth noting for the record.
-- =============================================================================

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO admin_role;

-- Prevents this exact bug from recurring: any sequence created by a
-- future migration automatically gets this grant too, rather than
-- requiring every future migration to remember to add it explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO admin_role;
