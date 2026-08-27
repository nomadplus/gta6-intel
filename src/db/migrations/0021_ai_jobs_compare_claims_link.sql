-- =============================================================================
-- Migration 0021: Phase 5 PR 7 -- ai_jobs focus-claim identity for
-- compare_claims.
--
-- classify_relevance (0014) and extract_claims (0015) scope by
-- source_item_id; detect_duplicates (0018) scopes by
-- (extraction_ai_result_id, extraction_candidate_index). compare_claims can
-- reuse neither: it is scoped to ONE existing focus claim, compared against
-- a bounded shortlist in a single call. Per the standing rule that each
-- operation decides its own concurrency semantics rather than inheriting a
-- sibling's, this adds its own column, its own CHECK, and its own partial
-- unique in-flight index.
--
-- PRE-FLIGHT GUARD (differs from migration 0018's situation): unlike
-- detect_duplicates, the compare_claims enum value HAS already been
-- written to ai_jobs -- by src/checks/aiRunOperation.check.ts, which used
-- it (prior to this PR) as an arbitrary unconstrained fixture value. Those
-- rows would have comparison_claim_id NULL and would violate the CHECK
-- below. That check deletes its own jobs in a finally block, and no
-- application code path has ever executed compare_claims outside that
-- check, so both the check-run database and production are expected to be
-- clean -- but this migration verifies that rather than assuming it, and
-- fails with an actionable message instead of an opaque constraint
-- violation on the ALTER TABLE below. This PR also changes
-- aiRunOperation.check.ts's own fixture to 'embed' going forward (see that
-- file's updated comment), so no NEW compare_claims rows are created by
-- checks after this migration is applied.
-- =============================================================================

DO $$
DECLARE legacy_count integer;
BEGIN
  SELECT count(*) INTO legacy_count FROM ai_jobs WHERE operation = 'compare_claims';
  IF legacy_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0021 pre-flight failed: % pre-existing ai_jobs row(s) with operation = ''compare_claims'' '
      'and no comparison_claim_id. These predate PR7 and were created by a test fixture '
      '(src/checks/aiRunOperation.check.ts), not by application code. Inspect and remove them before '
      'applying this migration.', legacy_count;
  END IF;
END $$;

ALTER TABLE "ai_jobs"
  ADD COLUMN "comparison_claim_id" integer REFERENCES "claims"("id") ON DELETE RESTRICT;

-- Bidirectional, one combined constraint (not two) -- same form and same
-- reasoning as ai_jobs_detect_duplicates_operation_consistency (0018).
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_compare_claims_operation_consistency"
  CHECK (
    ("operation" =  'compare_claims' AND "comparison_claim_id" IS NOT NULL)
    OR
    ("operation" <> 'compare_claims' AND "comparison_claim_id" IS NULL)
  );

-- Admin/observability join direction ("which comparisons targeted this
-- claim") -- distinct from the in-flight index below, which is keyed on
-- comparison_claim_id alone but scoped to pending/running rows only.
CREATE INDEX "ai_jobs_comparison_claim_idx" ON "ai_jobs" ("comparison_claim_id");

-- The in-flight concurrency guard. createPendingAiJob() (src/db/mutations/
-- aiJobs.ts) already catches ANY unique violation on ai_jobs generically
-- and returns {ok: false, reason: "already_in_flight"} -- no new
-- application code needed for this new index to take effect.
CREATE UNIQUE INDEX "ai_jobs_compare_claims_inflight_unique"
  ON "ai_jobs" ("comparison_claim_id")
  WHERE "operation" = 'compare_claims' AND "status" IN ('pending', 'running');
