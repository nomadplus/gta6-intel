-- =============================================================================
-- Migration 0016: Phase 5 PR 5 -- human review of extract_claims candidates
--
-- An extract_claims ai_result contains an ordered array of candidate claims.
-- `admin_decisions.ai_result_id` identifies the whole result, not one array
-- element, so it cannot by itself record a partial approval/rejection. This
-- append-only bridge identifies a proposal by (ai_result_id, candidate_index)
-- and records the resulting admin_decision plus, for an approval, the newly
-- materialized claim.
-- =============================================================================

ALTER TYPE "admin_audit_entity_type" ADD VALUE 'claim_proposal_review';

CREATE TABLE "claim_proposal_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_result_id" integer NOT NULL,
  "candidate_index" integer NOT NULL,
  "admin_decision_id" integer NOT NULL,
  "materialized_claim_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_proposal_reviews_candidate_index_nonnegative" CHECK ("candidate_index" >= 0),
  CONSTRAINT "claim_proposal_reviews_ai_result_id_ai_results_id_fk"
    FOREIGN KEY ("ai_result_id") REFERENCES "ai_results"("id"),
  CONSTRAINT "claim_proposal_reviews_admin_decision_id_admin_decisions_id_fk"
    FOREIGN KEY ("admin_decision_id") REFERENCES "admin_decisions"("id"),
  CONSTRAINT "claim_proposal_reviews_materialized_claim_id_claims_id_fk"
    FOREIGN KEY ("materialized_claim_id") REFERENCES "claims"("id")
);

CREATE UNIQUE INDEX "claim_proposal_reviews_candidate_unique"
  ON "claim_proposal_reviews" ("ai_result_id", "candidate_index");
CREATE UNIQUE INDEX "claim_proposal_reviews_decision_unique"
  ON "claim_proposal_reviews" ("admin_decision_id");

-- This review ledger is historical evidence of a human decision. It must be
-- append-only exactly like the status histories and admin audit log; an
-- erroneous decision is corrected by later claim administration, not by
-- erasing the original review record.
CREATE TRIGGER trg_claim_proposal_reviews_immutable
  BEFORE UPDATE OR DELETE ON claim_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();

ALTER TABLE public.claim_proposal_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON claim_proposal_reviews TO admin_role;
