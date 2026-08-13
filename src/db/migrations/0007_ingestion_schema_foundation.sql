-- =============================================================================
-- Migration 0007: Phase 4 PR 1 -- ingestion schema foundation
--
-- Schema-only foundation for the future source-discovery/ingestion system.
-- No URL normalization, SSRF protection, HTTP fetching, robots.txt
-- handling, pipeline logic, admin UI, RSS parsing, scheduling, retries, or
-- AI analysis is implemented here -- those are later Phase 4 PRs. This PR
-- adds the tables/columns/vocabulary that later PRs will read and write.
--
-- Four independent additions, bundled because they were all approved
-- together as the Phase 4 PR 1 schema:
--
--   A. discovery_providers: lookup table for HOW an item was discovered
--      (manual, rss, ...) -- same open-ended-taxonomy pattern as
--      source_types/source_item_types (migration 0001). This is distinct
--      from source provenance (source_relationships): discovery is how an
--      item entered the system, provenance is how it relates to other
--      reporting.
--   B. ingestion_status: a small, fixed vocabulary describing where one
--      ingestion attempt is in its lifecycle. Modeled as an ENUM, not a
--      lookup table, for the same reason investigation_status and
--      development_outcome are ENUMs (migration 0000) -- this defines core
--      pipeline logic and must stay a tightly controlled set, not an
--      open-ended taxonomy.
--   C. ingestion_jobs: one row per ingestion/discovery attempt.
--   D. source_items.normalized_url: added now so future ingestion code has
--      somewhere to write the normalized form, without implying any
--      uniqueness or dedup behavior yet -- see the column comment below.
--
-- Standing rule from this point forward (see docs/architecture.md "Data
-- API lockdown" for why): every migration that creates an application
-- table must explicitly secure that table in the same migration --
-- explicit REVOKE from anon/authenticated, explicit RLS enable, explicit
-- grants to app_role/admin_role -- rather than relying solely on the
-- ALTER DEFAULT PRIVILEGES statements from migration 0006/0005. Those
-- defaults are scoped to the role that ran the migration that set them;
-- Supabase's own default privileges for its `supabase_admin` role are a
-- separate, independently-controlled mechanism that can re-grant
-- anon/authenticated access to objects created by a different creating
-- role. Explicit per-migration statements are the only thing that isn't
-- contingent on which role happens to execute a future migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. discovery_providers
-- ---------------------------------------------------------------------------

CREATE TABLE "discovery_providers" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" varchar(64) NOT NULL,
  "label" varchar(200) NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_providers_slug_unique" UNIQUE("slug")
);

INSERT INTO "discovery_providers" (slug, label) VALUES
  ('manual', 'Manual Submission'),
  ('rss', 'RSS Feed');

-- ---------------------------------------------------------------------------
-- B. ingestion_status
-- ---------------------------------------------------------------------------

CREATE TYPE "ingestion_status" AS ENUM (
  'queued',
  'fetching',
  'stored',
  'duplicate',
  'needs_review',
  'blocked_by_policy',
  'robots_disallowed',
  'authentication_required',
  'paywalled',
  'unsupported',
  'fetch_failed',
  'rate_limited',
  'malformed'
);

-- ---------------------------------------------------------------------------
-- C. ingestion_jobs
--
-- started_at is deliberately separate from created_at: created_at is when
-- the job was queued, started_at is when a fetch attempt actually began.
-- Future per-domain rate limiting needs real fetch-attempt timing, not
-- queue timing -- no rate-limiting logic is implemented by this migration,
-- only the column it will eventually read.
-- ---------------------------------------------------------------------------

CREATE TABLE "ingestion_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "submitted_url" text NOT NULL,
  "normalized_url" text NOT NULL,
  "discovery_provider_id" integer NOT NULL,
  "initiated_by" "initiated_by" NOT NULL,
  "admin_user_id" integer,
  "status" "ingestion_status" NOT NULL DEFAULT 'queued',
  "http_status" integer,
  "content_type" varchar(200),
  "content_length" integer,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone,
  "next_retry_at" timestamp with time zone,
  "failure_reason" text,
  "source_item_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_discovery_provider_id_discovery_providers_id_fk"
  FOREIGN KEY ("discovery_provider_id") REFERENCES "discovery_providers"("id");
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_admin_user_id_admin_users_id_fk"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id");
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_source_item_id_source_items_id_fk"
  FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id");

-- Supports the approved future in-flight-redundancy rule: "if another job
-- with the same normalized_url is currently queued/fetching and was
-- created in the last hour, reuse it instead of starting a new one." This
-- is NOT historical deduplication (that's a post-fetch content-hash
-- decision, per source_items.normalized_url below) and is NOT enforced
-- here -- no uniqueness constraint, no application logic, just an index
-- shaped for the query that future logic will run:
--   SELECT ... WHERE normalized_url = $1 AND status IN ('queued','fetching')
--     AND created_at > now() - interval '1 hour'
-- Partial on status so the index stays small (most jobs settle into a
-- terminal status quickly and drop out of it), which is also why
-- created_at alone -- not a fixed cutoff -- is indexed here rather than
-- baking the 1-hour window into the index definition; that window is
-- application logic, not schema, and may change.
CREATE INDEX "ingestion_jobs_inflight_lookup_idx"
  ON "ingestion_jobs" ("normalized_url", "created_at")
  WHERE "status" IN ('queued', 'fetching');

-- ---------------------------------------------------------------------------
-- D. source_items.normalized_url
--
-- Indexed for future lookup, deliberately NOT unique. Publishers reuse
-- URLs (a canonical URL's content can change after publication), so
-- "same URL" cannot mean "same item" at the schema level. Future ingestion
-- logic distinguishes same-URL-same-hash (duplicate) from
-- same-URL-different-hash (needs_review) using rawContentHash, which
-- already exists on this table (migration 0000) -- no schema change
-- needed for that logic itself, only this column to key the lookup on.
-- ---------------------------------------------------------------------------

ALTER TABLE "source_items" ADD COLUMN "normalized_url" text;
CREATE INDEX "source_items_normalized_url_idx" ON "source_items" ("normalized_url");

-- =============================================================================
-- Security: explicit per-table lockdown for the two new tables (see the
-- standing rule at the top of this file). source_items already has RLS
-- enabled and its existing grants from migrations 0002/0004/0006 apply
-- unchanged to the new column -- no separate action needed there.
-- =============================================================================

-- --- anon/authenticated: no access, matching every other application table.
REVOKE ALL ON "discovery_providers" FROM anon, authenticated;
REVOKE ALL ON "ingestion_jobs" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "discovery_providers_id_seq" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "ingestion_jobs_id_seq" FROM anon, authenticated;

ALTER TABLE "discovery_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_jobs" ENABLE ROW LEVEL SECURITY;
-- No permissive policies created for either table -- deny-by-default, same
-- as every table in migration 0006. app_role/admin_role bypass RLS
-- (granted BYPASSRLS in 0006); their actual access is governed entirely by
-- the GRANT statements below.

-- --- app_role: deliberately NO grants on either new table.
--
-- The public website reads claims/sources/evidence -- published, reviewed
-- content. Ingestion jobs are pipeline/operational state (raw submitted
-- URLs, fetch attempts, failure reasons) that has no public-facing
-- purpose and was never asked for; discovery_providers is administrative
-- lookup data describing that same pipeline. Granting app_role read access
-- to either would be broader than any actual product need, so neither
-- gets a GRANT here. (source_items.normalized_url is visible to app_role
-- only because it's a column on a table app_role already has table-level
-- SELECT on from migration 0004 -- see note above.)

-- --- admin_role: full CRUD on both, consistent with every other
-- non-ledger operational table admin_role manages (migration 0004).
-- Neither table is an append-only ledger -- an ingestion job's status
-- legitimately moves through its lifecycle in place (queued -> fetching ->
-- stored/duplicate/needs_review/...), and discovery_providers is ordinary
-- reference data an admin may extend later (matching how source_types/
-- source_item_types are managed). This is the same server-side-only trust
-- boundary as the rest of admin_role's grants: ingestion processing code
-- runs privileged, not as the public app_role connection, whether it was
-- triggered by a human admin, a scheduler, or an AI recommendation
-- (initiated_by covers that distinction at the row level, not the
-- connection level).
GRANT SELECT, INSERT, UPDATE, DELETE ON "discovery_providers", "ingestion_jobs" TO admin_role;
GRANT USAGE ON SEQUENCE "discovery_providers_id_seq" TO admin_role;
GRANT USAGE ON SEQUENCE "ingestion_jobs_id_seq" TO admin_role;
-- (Migration 0005's ALTER DEFAULT PRIVILEGES would grant these sequence
-- usages automatically too, if this migration runs under the same
-- creating role -- these explicit grants make that guarantee independent
-- of which role executes this file, per the standing rule above.)
