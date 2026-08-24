-- =============================================================================
-- Migration 0015: Phase 5 PR 4 -- extract_claims in-flight concurrency guard
--
-- 'extract_claims' was already added to the ai_operation enum back in
-- Phase 5 PR 1 (see migration 0000's initial enum definition / types.ts's
-- AiOperation union) -- no enum ALTER is needed here. This migration adds
-- ONLY a partial unique index, scoped specifically to
-- operation = 'extract_claims', mirroring migration 0014's
-- ai_jobs_classify_relevance_inflight_unique exactly -- per that
-- migration's own comment, each source-item-scoped operation decides its
-- own concurrency semantics in its own migration rather than inheriting
-- another operation's index.
--
-- Guards against two callers -- most plausibly two admin clicks of
-- "Extract claims" on the same source item, or a double form submission
-- -- racing to create simultaneous IN-FLIGHT (pending/running)
-- extract_claims attempts for the same source item. Scoped to in-flight
-- statuses only, so unlimited historical succeeded/failed attempts
-- accumulate freely and a later deliberate re-analysis is never blocked
-- by this index -- same rationale as 0014. (Phase 5 PR 4's admin UI does
-- not itself expose a "re-extract after success" action, but nothing at
-- this DB layer prevents a future PR from adding one.)
--
-- Additive only. ai_jobs is already locked down (migration 0006); a new
-- index on an already-locked-down table needs no grant/RLS changes, same
-- reasoning as 0014.
-- =============================================================================

CREATE UNIQUE INDEX "ai_jobs_extract_claims_inflight_unique"
  ON "ai_jobs" ("source_item_id")
  WHERE "operation" = 'extract_claims' AND "status" IN ('pending', 'running') AND "source_item_id" IS NOT NULL;
