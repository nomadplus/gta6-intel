-- =============================================================================
-- Migration 0011: Phase 4 PR 8 -- discovery feed configuration
--
-- Lets an admin register RSS/Atom feeds to monitor, as structured
-- configuration data. This migration adds ONLY the table and its
-- security posture -- no fetching, parsing, scheduling, or ingestion_jobs
-- creation exists yet (that is PR 9's automated processor and PR 10's
-- RSS poller). last_polled_at / last_poll_status are written by nothing
-- until PR 10 exists; they're included now so that PR doesn't need a
-- schema change of its own for two columns that clearly belong here.
--
-- feed_url vs. ingestion's submitted/normalized/canonical URL model:
-- ingestion_jobs and source_items carry three distinct URL-shaped columns
-- (submittedUrl, normalizedUrl/canonicalUrl) because that data is
-- historical evidence -- what was actually submitted or retrieved must be
-- preserved verbatim for audit/provenance, separately from its normalized
-- form used for identity matching. discovery_feeds.feed_url has no such
-- requirement: it is operational configuration (which feed the system
-- should poll), not a historical record of anything that happened. There
-- is nothing to preserve "as originally typed" -- if the normalized form
-- changes (e.g. a tracking parameter is stripped), the config should just
-- reflect the corrected feed URL, not retain a stale submitted variant
-- alongside it. So this table has exactly one URL column, and the
-- application layer (src/db/mutations/discoveryFeeds.ts) is responsible
-- for writing the already-normalized form into it via the existing,
-- reused normalizeUrl() from src/lib/ingestion/urlNormalization.ts -- no
-- new normalization logic, and no separate raw/submitted column.
--
-- A feed must reference an existing sources row (source_id NOT NULL, no
-- ON DELETE CASCADE -- deleting a source with a configured feed should be
-- an explicit, deliberate admin action, not a side effect of a feed
-- config change). Inline source creation from the feed form is
-- deliberately NOT part of this PR -- source creation stays in the
-- existing Sources admin workflow, per product decision.
-- =============================================================================

CREATE TABLE "discovery_feeds" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_id" integer NOT NULL,
  -- Already-normalized (via normalizeUrl()) at write time -- see file
  -- header. Unique so the same feed cannot be configured twice.
  "feed_url" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "polling_interval_minutes" integer NOT NULL DEFAULT 60,
  -- Both null until PR 10's poller exists to write them. last_poll_status
  -- is free text (a short human-readable outcome, e.g. "ok" or an error
  -- summary) rather than an enum -- deliberately not modeled as tightly
  -- as ingestion_status: this is a single rolling status for observability,
  -- not a pipeline state machine with its own transition logic.
  "last_polled_at" timestamp with time zone,
  "last_poll_status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_feeds_feed_url_unique" UNIQUE ("feed_url"),
  CONSTRAINT "discovery_feeds_polling_interval_positive" CHECK ("polling_interval_minutes" > 0)
);

ALTER TABLE "discovery_feeds" ADD CONSTRAINT "discovery_feeds_source_id_sources_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "sources"("id");

-- Every list of feeds is naturally viewed per-source in the admin UI, and
-- the future poller (PR 10) will need "which feeds belong to this source"
-- far less often than "which feeds are due to be polled" -- but an index
-- on the FK is still worth having for the admin list/detail joins in this
-- PR, at negligible cost on a small table.
CREATE INDEX "discovery_feeds_source_id_idx" ON "discovery_feeds" ("source_id");

-- =============================================================================
-- Security: explicit per-table lockdown, per the standing rule (migration
-- 0007 and every table since).
-- =============================================================================

-- --- anon/authenticated: no access, matching every other application table.
REVOKE ALL ON "discovery_feeds" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "discovery_feeds_id_seq" FROM anon, authenticated;

ALTER TABLE "discovery_feeds" ENABLE ROW LEVEL SECURITY;
-- No permissive policies -- deny-by-default, same as every table in
-- migration 0006. app_role/admin_role bypass RLS (granted BYPASSRLS in
-- 0006); their actual access is governed entirely by the GRANT statements
-- below.

-- --- app_role: deliberately NO grants.
--
-- Feed configuration is pipeline/operational state with no public-facing
-- purpose, same reasoning as discovery_providers/ingestion_jobs in
-- migration 0007 -- the public website has no product need to know which
-- feeds are being monitored.

-- --- admin_role: full CRUD, consistent with discovery_providers/
-- ingestion_jobs. Not an append-only ledger -- enabling/disabling a feed
-- or correcting its polling interval is an ordinary in-place edit, not a
-- historical fact that must be preserved across a status change.
GRANT SELECT, INSERT, UPDATE, DELETE ON "discovery_feeds" TO admin_role;
GRANT USAGE ON SEQUENCE "discovery_feeds_id_seq" TO admin_role;
