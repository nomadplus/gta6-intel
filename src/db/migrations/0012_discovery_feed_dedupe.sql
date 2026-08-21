-- =============================================================================
-- Migration 0012: Phase 4 PR 10 -- discovery-feed provenance + dedupe
--
-- Two additive changes to ingestion_jobs, applied in this order
-- deliberately (the column must exist before the partial index that
-- depends on it):
--
--   A. discovery_feed_id -- nullable FK to discovery_feeds(id), populated
--      ONLY for system-discovered jobs (initiated_by = 'system'). Manual
--      admin submissions always leave this NULL. Before this column,
--      ingestion_jobs could only record the generic discovery_provider_id
--      ('rss' vs 'manual') -- it had no way to say WHICH feed found a
--      given item. This is operational/pipeline provenance (Section 3 of
--      the project's standing instructions: "discovery" is distinct from
--      the epistemic source_relationships provenance graph), not a
--      change to the claims/evidence data model itself.
--
--   B. A PARTIAL unique index on normalized_url, scoped to
--      discovery_feed_id IS NOT NULL. This is the authoritative
--      concurrency-safety mechanism for PR 10's RSS poller: two
--      overlapping poll invocations (or a poll run overlapping a retried
--      manual trigger) racing to create a job for the same
--      normalized_url will have one INSERT succeed and the other fail
--      with a unique-violation (23505), which the application layer
--      catches and treats as "already discovered" rather than crashing.
--      A non-unique index plus a check-then-insert query cannot close
--      that race -- only a database constraint can.
--
--      Scoping the constraint to discovery_feed_id IS NOT NULL
--      deliberately leaves manual ingestion untouched: an admin can still
--      manually resubmit the same normalized_url as many times as the
--      existing manual flow already allows (e.g. after a hash change),
--      because those rows have discovery_feed_id = NULL and fall outside
--      this index's predicate entirely. This constraint only ever
--      prevents two SYSTEM-discovered jobs for the same URL from
--      coexisting -- it says nothing about manual jobs, and nothing about
--      a manual and a system job coexisting for the same URL (the
--      application's discovery pre-check handles that case as an
--      efficiency optimization, not a hard constraint -- see
--      src/db/mutations/discoveryPolling.ts).
--
--      This same partial index also serves as the efficient existence
--      check for "has any feed already discovered this URL" -- a query
--      shaped as `WHERE normalized_url = $1 AND discovery_feed_id IS NOT
--      NULL` matches this index's predicate exactly, so no separate
--      plain index on normalized_url is needed for that purpose.
-- =============================================================================

ALTER TABLE "ingestion_jobs"
  ADD COLUMN "discovery_feed_id" integer;

ALTER TABLE "ingestion_jobs"
  ADD CONSTRAINT "ingestion_jobs_discovery_feed_id_discovery_feeds_id_fk"
  FOREIGN KEY ("discovery_feed_id") REFERENCES "discovery_feeds"("id");

-- Plain index on the FK itself, for the admin/observability direction
-- ("which jobs did this feed produce") -- distinct from the partial
-- unique index above, which is keyed on normalized_url, not
-- discovery_feed_id.
CREATE INDEX "ingestion_jobs_discovery_feed_id_idx" ON "ingestion_jobs" ("discovery_feed_id");

-- The authoritative dedupe/race-safety constraint -- see file header.
CREATE UNIQUE INDEX "ingestion_jobs_discovery_feed_normalized_url_unique"
  ON "ingestion_jobs" ("normalized_url")
  WHERE "discovery_feed_id" IS NOT NULL;

-- No REVOKE/GRANT changes needed -- discovery_feed_id is a new column on
-- an existing table (ingestion_jobs), which already has its full
-- security posture (RLS enabled, no anon/authenticated grants,
-- admin_role has SELECT/INSERT/UPDATE/DELETE) from migration 0007. A new
-- column inherits the table's existing grants automatically; there is no
-- new table or sequence here that would need its own lockdown.
