-- =============================================================================
-- Migration 0014: Phase 5 PR 3 -- ai_jobs.source_item_id link + in-flight
-- uniqueness guard
--
-- Adds a nullable ai_jobs.source_item_id FK -- an opaque passthrough that
-- mirrors ai_results.claim_id exactly, just one level up on the job row
-- itself. Populated for any operation scoped to a specific source item
-- (classify_relevance today; a future extract_claims or similar could
-- reuse the COLUMN identically). This is what lets admin review/recovery
-- query "which source items have no classify_relevance job yet."
--
-- Also adds a partial unique index scoped SPECIFICALLY to
-- classify_relevance, restricted to IN-FLIGHT statuses (pending/running)
-- only:
--
--   (source_item_id) WHERE operation = 'classify_relevance'
--     AND status IN ('pending','running') AND source_item_id IS NOT NULL
--
-- This is the authoritative, concurrency-safe guard against two callers
-- -- the automatic synchronous trigger right after ingestion confirmation,
-- and a manual admin recovery action for a missing/stale/failed
-- classification -- racing to create two simultaneous in-flight attempts
-- for the same source item's classify_relevance job. Deliberately NOT a
-- plain (unscoped) unique index: succeeded/failed rows are excluded from
-- the predicate, so unlimited historical attempts accumulate freely and a
-- legitimate future re-analysis workflow (multiple classification
-- attempts over time) is never blocked by this constraint -- only two
-- attempts *simultaneously in flight* for the same item are prevented.
--
-- Deliberately scoped to operation = 'classify_relevance' specifically,
-- NOT generically to every (operation, source_item_id) pair: PR3 owns
-- classify_relevance's concurrency semantics, not those of any future
-- source-item-scoped AI operation (extract_claims, detect_duplicates,
-- provenance/evidence work, etc.). Each future operation that needs the
-- same kind of protection should get its own explicitly-scoped index in
-- its own migration, deciding its own concurrency semantics rather than
-- inheriting this one by accident.
--
-- Additive/nullable only -- no existing column, constraint, or enum value
-- is touched. No grant/RLS changes needed: ai_jobs is already locked down
-- (anon/authenticated revoked, RLS admin_role-only grants) from migration
-- 0006, and new columns/indexes on an already-locked-down table inherit
-- that same access -- same reasoning as migration 0009's ingestion_jobs
-- additions.
-- =============================================================================

ALTER TABLE "ai_jobs" ADD COLUMN "source_item_id" integer REFERENCES "source_items"("id");

CREATE INDEX "ai_jobs_source_item_id_idx" ON "ai_jobs" ("source_item_id");

CREATE UNIQUE INDEX "ai_jobs_classify_relevance_inflight_unique"
  ON "ai_jobs" ("source_item_id")
  WHERE "operation" = 'classify_relevance' AND "status" IN ('pending', 'running') AND "source_item_id" IS NOT NULL;
