-- =============================================================================
-- Migration 0020: Phase 5 PR 7 -- 'claim_comparison_review' audit entity type.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with a statement that
-- uses the new value (PostgreSQL restriction on enum value visibility
-- mid-transaction), so -- consistent with every other enum-value addition
-- in this project (migrations 0008, 0010, 0013, 0019) -- this migration
-- contains ONLY this one statement.
--
-- One compare_claims ai_result contains up to MAX_COMPARE_CLAIMS_ASSESSMENTS
-- independently reviewable assessments. admin_audit_log entries about a
-- single human decision therefore need an entity type more precise than
-- 'claim_relationship' (which identifies the resulting graph edge, not the
-- review of one AI recommendation) -- exactly the distinction migration
-- 0016 drew when it added 'claim_proposal_review' for PR5's extract_claims
-- candidates.
-- =============================================================================

ALTER TYPE "admin_audit_entity_type" ADD VALUE 'claim_comparison_review';
