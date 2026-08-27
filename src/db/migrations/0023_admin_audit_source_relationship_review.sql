-- =============================================================================
-- Migration 0023: Phase 5 PR 8b -- 'source_relationship_review' audit entity
-- type.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with a statement that
-- uses the new value (PostgreSQL restriction on enum value visibility
-- mid-transaction), so -- consistent with every other enum-value addition
-- in this project (migrations 0008, 0010, 0013, 0019, 0020) -- this
-- migration contains ONLY this one statement.
--
-- One analyse_provenance ai_result can propose several independently
-- reviewable directed edges over a claim-anchored source-item cluster.
-- admin_audit_log entries about a single human decision therefore need an
-- entity type more precise than 'source_relationship' (which identifies the
-- resulting graph edge, not the review of one AI recommendation) -- exactly
-- the distinction migration 0020 drew for PR7's claim_comparison_review.
-- =============================================================================

ALTER TYPE "admin_audit_entity_type" ADD VALUE 'source_relationship_review';
