-- =============================================================================
-- Migration 0024: Phase 5 PR 8b -- ai_jobs claim-anchored cluster identity
-- for analyse_provenance.
--
-- classify_relevance (0014) scopes by source_item_id; detect_duplicates
-- (0018) scopes by (extraction_ai_result_id, extraction_candidate_index);
-- compare_claims (0021) scopes by comparison_claim_id. analyse_provenance
-- can reuse none of these: it is scoped to ONE claim whose linked
-- source-item cluster is being analysed in a single call. Per the standing
-- rule that each operation decides its own concurrency semantics rather
-- than inheriting a sibling's, this adds its own column, its own CHECK, and
-- its own partial unique in-flight index -- same shape as migration 0021.
--
-- provenance_cluster_fingerprint is added alongside provenance_claim_id in
-- this same migration (rather than a fourth migration) because both
-- columns are introduced by the same PR for the same operation and neither
-- depends on data existing in the other; splitting them would not reduce
-- risk, only migration count.
--
-- PRE-FLIGHT GUARD: analyse_provenance rows created by ANY process prior
-- to this migration would have provenance_claim_id NULL and would violate
-- the CHECK below -- this guard is general and does not assume a specific
-- origin for such rows. In practice, the only known source of such rows
-- prior to this PR is src/checks/aiRunOperation.check.ts, which used the
-- analyse_provenance enum value (prior to this PR) as an arbitrary
-- unconstrained fixture value, exactly the same situation migration
-- 0021's header describes for compare_claims; that check deletes its own
-- jobs in a finally block, and no application code path has ever executed
-- analyse_provenance outside that check, so both the check-run database
-- and production are expected to be clean. This migration verifies that
-- expectation directly against ai_jobs rather than assuming it or
-- special-casing any one origin, and fails with an actionable message
-- instead of an opaque constraint violation on the ALTER TABLE below if
-- ANY pre-existing analyse_provenance row is found, regardless of what
-- created it. This PR also changes aiRunOperation.check.ts's own fixture
-- to a named generic constant (currently 'embed') going forward, so no
-- NEW analyse_provenance rows are created by that check after this
-- migration is applied.
-- =============================================================================

DO $$
DECLARE legacy_count integer;
BEGIN
  SELECT count(*) INTO legacy_count FROM ai_jobs WHERE operation = 'analyse_provenance';
  IF legacy_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0024 pre-flight failed: % pre-existing ai_jobs row(s) with operation = ''analyse_provenance'' '
      'found with no provenance_claim_id column to satisfy yet. This migration adds a NOT-conditionally-null '
      'CHECK requiring provenance_claim_id whenever operation = ''analyse_provenance'' -- every existing row for '
      'this operation must be inspected and either removed or backfilled with a valid provenance_claim_id before '
      'this migration can apply safely, regardless of what process created them.', legacy_count;
  END IF;
END $$;

ALTER TABLE "ai_jobs"
  ADD COLUMN "provenance_claim_id" integer REFERENCES "claims"("id") ON DELETE RESTRICT,
  ADD COLUMN "provenance_cluster_fingerprint" varchar(64);

-- Bidirectional, one combined constraint (not two) -- same form and same
-- reasoning as ai_jobs_compare_claims_operation_consistency (0021).
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_provenance_operation_consistency"
  CHECK (
    ("operation" =  'analyse_provenance' AND "provenance_claim_id" IS NOT NULL)
    OR
    ("operation" <> 'analyse_provenance' AND "provenance_claim_id" IS NULL)
  );

-- Admin/observability join direction ("which analyses targeted this
-- claim") -- distinct from the in-flight index below, which is keyed on
-- provenance_claim_id alone but scoped to pending/running rows only.
CREATE INDEX "ai_jobs_provenance_claim_idx" ON "ai_jobs" ("provenance_claim_id");

-- The in-flight concurrency guard. createPendingAiJob() (src/db/mutations/
-- aiJobs.ts) already catches ANY unique violation on ai_jobs generically
-- and returns {ok: false, reason: "already_in_flight"} -- no new
-- application code needed for this new index to take effect.
CREATE UNIQUE INDEX "ai_jobs_provenance_inflight_unique"
  ON "ai_jobs" ("provenance_claim_id")
  WHERE "operation" = 'analyse_provenance' AND "status" IN ('pending', 'running');
