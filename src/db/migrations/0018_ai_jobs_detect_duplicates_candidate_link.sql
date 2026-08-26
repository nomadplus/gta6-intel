-- =============================================================================
-- Migration 0018: Phase 5 PR 6 -- ai_jobs candidate-scoped identity for
-- detect_duplicates.
--
-- classify_relevance (migration 0014) and extract_claims (migration 0015)
-- are both scoped by ai_jobs.source_item_id -- exactly one in-flight
-- attempt per source item. detect_duplicates cannot reuse that column for
-- its concurrency guard: multiple extract_claims candidates share one
-- source_item_id, but each candidate needs its OWN independent duplicate
-- check. This migration adds a second, narrower identity -- one
-- extract_claims candidate, identified the same durable way PR5's
-- claim_proposal_reviews already identifies one:
-- (extraction_ai_result_id, extraction_candidate_index).
--
-- Both columns are nullable and populated ONLY for operation =
-- 'detect_duplicates' -- exactly the same "opaque passthrough, populated
-- at pending-job-creation time" shape source_item_id already has (see
-- migration 0014's own header), just scoped one level narrower. No
-- existing row is affected: 'detect_duplicates' has never been used by
-- any application code (see migration 0013's own comment), so every
-- historical row already satisfies every constraint below trivially.
--
-- Three integrity rules, enforced at the database layer rather than left
-- to application discipline:
--
--   1. ai_jobs_extraction_candidate_index_nonnegative -- candidate_index
--      cannot be negative when present (mirrors
--      claim_proposal_reviews_candidate_index_nonnegative from migration
--      0016 exactly).
--   2. ai_jobs_detect_duplicates_operation_consistency -- a single
--      combined CHECK enforcing BOTH directions: operation =
--      'detect_duplicates' REQUIRES both columns populated, and every
--      OTHER operation REQUIRES both columns null. This is deliberately
--      one constraint, not two separate ones (an earlier draft had a
--      standalone paired-nullability check plus a separate
--      detect-duplicates-requires-link check) -- the combined form
--      already implies pairing in both of its branches, so a second,
--      narrower constraint would have been redundant.
--   3. The partial unique index below -- the actual in-flight
--      concurrency guard, scoped specifically to operation =
--      'detect_duplicates' and to pending/running rows only, mirroring
--      migrations 0014/0015's own "each operation decides its own
--      concurrency semantics in its own migration" precedent exactly.
--      Historical succeeded/failed rows accumulate freely and are never
--      blocked by this index.
--
-- extraction_ai_result_id's FK uses ON DELETE RESTRICT (this project's
-- other FKs all rely on the implicit default, NO ACTION -- functionally
-- identical to RESTRICT for a non-deferred constraint, so this is a
-- documentation-of-intent choice, not a behavioral deviation from
-- existing convention): an ai_results row that a detect_duplicates job
-- points back to must never be silently deletable out from under that
-- job's own historical identity. In practice ai_results rows are never
-- deleted anywhere in this codebase, so this is defense-in-depth, not a
-- change to any real deletion path.
--
-- createPendingAiJob() (src/db/mutations/aiJobs.ts) already catches ANY
-- unique-violation on ai_jobs generically and returns {ok: false, reason:
-- "already_in_flight"} -- it has no idea which partial index caused the
-- rejection. The new index below gives detect_duplicates the exact same
-- race protection PR3/PR4 already have, with no changes needed to that
-- generic catch.
-- =============================================================================

ALTER TABLE "ai_jobs"
  ADD COLUMN "extraction_ai_result_id" integer REFERENCES "ai_results"("id") ON DELETE RESTRICT,
  ADD COLUMN "extraction_candidate_index" integer;

ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_extraction_candidate_index_nonnegative"
  CHECK ("extraction_candidate_index" IS NULL OR "extraction_candidate_index" >= 0);

ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_detect_duplicates_operation_consistency"
  CHECK (
    (
      "operation" = 'detect_duplicates'
      AND "extraction_ai_result_id" IS NOT NULL
      AND "extraction_candidate_index" IS NOT NULL
    )
    OR
    (
      "operation" <> 'detect_duplicates'
      AND "extraction_ai_result_id" IS NULL
      AND "extraction_candidate_index" IS NULL
    )
  );

CREATE INDEX "ai_jobs_extraction_candidate_idx"
  ON "ai_jobs" ("extraction_ai_result_id", "extraction_candidate_index");

CREATE UNIQUE INDEX "ai_jobs_detect_duplicates_inflight_unique"
  ON "ai_jobs" ("extraction_ai_result_id", "extraction_candidate_index")
  WHERE "operation" = 'detect_duplicates' AND "status" IN ('pending', 'running');
