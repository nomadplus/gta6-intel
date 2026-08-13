-- =============================================================================
-- Migration 0004: Phase 3 admin foundation
--
-- Four independent changes, bundled because they were all approved together:
--   A. admin_users: application-level role + Supabase Auth linkage
--   B. admin_audit_log: append-only general admin activity log (distinct
--      from admin_decisions, which is scoped to AI-recommendation review)
--   C. claim_relationships / source_relationships: self-link + duplicate
--      prevention at the database level
--   D. Two-tier Postgres roles: app_role tightened to SELECT-only,
--      admin_role introduced for authorized server-side mutations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. admin_users: role + auth linkage
-- ---------------------------------------------------------------------------

CREATE TYPE "admin_role" AS ENUM ('owner', 'editor', 'reviewer', 'read_only_analyst');

ALTER TABLE "admin_users" ADD COLUMN "auth_user_id" varchar(64);
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_auth_user_id_unique" UNIQUE ("auth_user_id");
ALTER TABLE "admin_users" ADD COLUMN "role" "admin_role" NOT NULL DEFAULT 'read_only_analyst';

-- ---------------------------------------------------------------------------
-- B. admin_audit_log
-- ---------------------------------------------------------------------------

CREATE TYPE "admin_audit_action" AS ENUM ('create', 'update', 'link', 'unlink', 'transition', 'delete');

CREATE TYPE "admin_audit_entity_type" AS ENUM (
  'claim', 'source', 'source_item', 'evidence', 'topic',
  'claim_source', 'claim_evidence', 'claim_topic',
  'claim_relationship', 'source_relationship',
  'investigation_status_history', 'development_outcome_history'
);

CREATE TABLE "admin_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "admin_user_id" integer NOT NULL,
  "action" "admin_audit_action" NOT NULL,
  "entity_type" "admin_audit_entity_type" NOT NULL,
  "entity_id" integer,
  "summary" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_admin_users_id_fk"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id");

-- Same append-only pattern as the Phase 1 status ledgers: immutability
-- enforced by trigger below (section D), not just by grants.

-- ---------------------------------------------------------------------------
-- C. Relationship integrity constraints
--
-- claim_relationships: symmetric types (equivalent, related, contradicts)
-- are canonicalized by the application (lower claim id always stored as
-- claim_id_a) before insert -- see src/db/mutations/claimRelationships.ts.
-- This constraint then catches BOTH literal duplicates and reversed-order
-- symmetric duplicates, because canonicalization means a reversed
-- symmetric pair becomes the identical row before it ever reaches this
-- constraint. Directional types (subsumes, refines) are never
-- canonicalized, so A-subsumes-B and B-subsumes-A remain distinct, valid
-- rows, exactly as intended.
--
-- source_relationships: provenance relationships are inherently
-- directional (citation, derivative, repetition, etc), so this only
-- guards against a literal duplicate row and a self-link -- no
-- canonicalization is applied or intended here.
-- ---------------------------------------------------------------------------

ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_no_self_link"
  CHECK ("claim_id_a" <> "claim_id_b");
CREATE UNIQUE INDEX "claim_relationships_no_duplicate"
  ON "claim_relationships" ("claim_id_a", "claim_id_b", "relationship_type");

ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_no_self_link"
  CHECK ("source_item_id_a" <> "source_item_id_b");
CREATE UNIQUE INDEX "source_relationships_no_duplicate"
  ON "source_relationships" ("source_item_id_a", "source_item_id_b", "relationship_type");

-- ---------------------------------------------------------------------------
-- D. Two-tier Postgres roles for the admin system
--
-- app_role: tightened to SELECT-only. It never needed write access -- that
-- was only ever a Phase 1 default with no admin system yet to use it.
--
-- admin_role: new. Used exclusively by server-side mutation code AFTER
-- requireAdmin() has already verified the Supabase Auth session and the
-- caller's admin_users.role. This is a coarse trust boundary (authorized-
-- mutation-code vs public-read-code), NOT a stand-in for the fine-grained
-- owner/editor/reviewer/read_only_analyst application roles, which remain
-- enforced entirely in application code.
-- ---------------------------------------------------------------------------

-- Revoke the write privileges app_role was given in migration 0002 --
-- the public site only ever needs to read.
REVOKE INSERT, UPDATE, DELETE ON
  projects, topics, admin_users, source_types, source_item_types,
  sources, source_items, source_relationships, claims, claim_topics,
  claim_relationships, claim_sources, evidence, claim_evidence,
  ai_jobs, ai_results, admin_decisions,
  investigation_transition_evidence, development_transition_evidence
FROM app_role;
REVOKE INSERT ON
  claim_investigation_status_history, claim_development_outcome_history
FROM app_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role') THEN
    CREATE ROLE admin_role WITH LOGIN PASSWORD 'admin_dev_password';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE gta6_intel TO admin_role;
GRANT USAGE ON SCHEMA public TO admin_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO admin_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects, topics, admin_users, source_types, source_item_types,
  sources, source_items, source_relationships, claims, claim_topics,
  claim_relationships, claim_sources, evidence, claim_evidence,
  ai_jobs, ai_results, admin_decisions
TO admin_role;

-- Append-only ledgers: INSERT and SELECT only, same rule as Phase 1 --
-- admin_role does not get an exemption from this.
GRANT SELECT, INSERT ON
  claim_investigation_status_history,
  claim_development_outcome_history,
  investigation_transition_evidence,
  development_transition_evidence,
  admin_audit_log
TO admin_role;

GRANT SELECT ON claim_status_timeline TO admin_role;

-- admin_audit_log gets the same immutability trigger as the status
-- ledgers -- append-only applies to the general audit trail too, not
-- just claim status history.
CREATE TRIGGER trg_admin_audit_log_immutable
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();
