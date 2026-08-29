-- =============================================================================
-- Migration 0028: Phase 6 PR 6.1 -- discovery candidate ledger foundation
--
-- Adds a durable ledger sitting UPSTREAM of ingestion_jobs in the
-- discovery pipeline, with no wiring into any live route/cron yet:
--
--   provider/feed sighting
--           |
--           v
--   discovery_candidate_observations   (one row per operational sighting)
--           |
--           v
--   discovery_candidates               (one row per globally-normalized URL)
--           |
--           v
--   ingestion_jobs                     (existing Phase 4 pipeline)
--
-- Multiple feeds/providers surfacing the same normalized URL are
-- OPERATIONAL DISCOVERY FACTS ONLY -- never corroboration, provenance, or
-- evidence of any kind. That epistemic graph remains exclusively
-- source_relationships, decided by analyse_provenance or a human. Nothing
-- in this migration or the code that writes these tables is permitted to
-- influence source_relationships, claims, or any other public epistemic
-- state.
--
-- After this migration deploys, both new tables are dormant/empty in
-- production -- no discovery provider exists yet to call
-- recordDiscoverySighting(), and nothing calls
-- claimEligibleCandidatesForPromotion() from a route or cron. This
-- mirrors migration 0026's own rollout (source_item_links existed and was
-- fully tested for one release before anything wrote to it in production).
--
-- discoveryAdmissibility is ONE enum, not two, with a strict fold order
-- excluded < held < eligible that is NEVER derived from PostgreSQL's enum
-- declaration order -- discovery_admissibility_rank() below is the single
-- source of truth for that ordering, so a future enum addition (e.g.
-- inserting a new value between existing ones) can never silently change
-- fold semantics. Its pure-TypeScript mirror lives in
-- src/lib/discovery/candidateEligibility.ts, for deterministic test parity
-- only -- it is NEVER the authority for persisted state; only the
-- database-side trigger below is.
-- =============================================================================

CREATE TYPE "discovery_admissibility" AS ENUM ('excluded', 'held', 'eligible');

CREATE OR REPLACE FUNCTION discovery_admissibility_rank(a discovery_admissibility)
RETURNS smallint AS $$
BEGIN
  CASE a
    WHEN 'excluded' THEN RETURN 0;
    WHEN 'held'      THEN RETURN 1;
    WHEN 'eligible'  THEN RETURN 2;
    ELSE
      -- Fail closed: a future enum addition to discovery_admissibility
      -- that forgets to update this function must never silently return
      -- NULL (which would make every rank comparison in this migration's
      -- triggers compare against NULL, quietly disabling the fold
      -- invariant rather than visibly breaking). Raising here is what
      -- actually guarantees "a future addition to this enum can never
      -- silently change fold semantics" -- an unmapped value now fails
      -- loudly instead of being tolerated.
      RAISE EXCEPTION 'unmapped discovery_admissibility value: %', a;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ---------------------------------------------------------------------------
-- discovery_candidates: one row per globally-normalized URL.
--
-- admissibility is a DATABASE-MAINTAINED, MONOTONIC fold over every
-- observation ever recorded against this candidate (see the raise trigger
-- on discovery_candidate_observations below) -- it can only ever move
-- toward 'eligible', never backward, and every newly inserted row is
-- forced to 'excluded' regardless of what a caller supplies. Inserting a
-- genuine observation is the ONLY mechanism that can raise a candidate's
-- admissibility; there is deliberately no application-facing path that
-- creates a candidate at 'held'/'eligible' directly.
-- ---------------------------------------------------------------------------

CREATE TABLE "discovery_candidates" (
  "id" serial PRIMARY KEY NOT NULL,
  "normalized_url" text NOT NULL,
  "admissibility" "discovery_admissibility" NOT NULL DEFAULT 'excluded',
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "discovery_candidates_normalized_url_unique" UNIQUE ("normalized_url"),
  CONSTRAINT "discovery_candidates_last_seen_not_before_first_seen"
    CHECK ("last_seen_at" >= "first_seen_at")
);

-- Shaped exactly for the promotion-claim query: oldest-eligible-first,
-- scoped to only the rows that query ever touches.
CREATE INDEX "discovery_candidates_eligible_first_seen_idx"
  ON "discovery_candidates" ("first_seen_at", "id")
  WHERE "admissibility" = 'eligible';

-- Forces every newly inserted candidate to 'excluded' at the database
-- layer, regardless of caller-supplied input -- this is a hard guarantee,
-- not application discipline. The candidate upsert used by
-- recordDiscoverySighting() below relies on this: it never attempts to
-- raise admissibility itself, only identity (normalized_url) and
-- last_seen_at.
CREATE OR REPLACE FUNCTION force_discovery_candidate_initial_admissibility()
RETURNS TRIGGER AS $$
BEGIN
  NEW.admissibility := 'excluded';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_candidates_force_initial_admissibility
  BEFORE INSERT ON discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION force_discovery_candidate_initial_admissibility();

-- Partial-mutation guard: identity fields are immutable, admissibility
-- can only increase (by rank, never by enum declaration order) and ONLY
-- when justified by an existing observation of at least that rank (see
-- below), and last_seen_at can only move forward. Unlike
-- reject_status_history_mutation() (blanket reject-all, used by the
-- append-only ledgers), this permits a narrow, ongoing set of legitimate
-- in-place updates -- a candidate's admissibility genuinely does advance
-- over its lifetime, and its last_seen_at genuinely does advance on every
-- valid sighting, including a replay. DELETE is always rejected; this
-- ledger never shrinks.
CREATE OR REPLACE FUNCTION restrict_discovery_candidate_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'discovery_candidates rows cannot be deleted (id=%)', OLD.id;
  END IF;

  IF NEW.normalized_url IS DISTINCT FROM OLD.normalized_url
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'discovery_candidates identity fields (normalized_url/first_seen_at/created_at) are immutable (id=%)', OLD.id;
  END IF;

  IF discovery_admissibility_rank(NEW.admissibility) < discovery_admissibility_rank(OLD.admissibility) THEN
    RAISE EXCEPTION 'discovery_candidates.admissibility cannot decrease (id=%)', OLD.id;
  END IF;

  -- A candidate may never carry an admissibility rank higher than the
  -- highest rank actually represented by one of its own observations --
  -- this closes the gap an app-trusting or DELETE-revoking approach would
  -- leave open: an arbitrary direct UPDATE raising admissibility with no
  -- justifying observation must fail, regardless of who issues it
  -- (including admin_role, which legitimately needs UPDATE for the
  -- last_seen_at replay path and so cannot simply be denied UPDATE
  -- entirely). The legitimate path -- INSERT observation -> AFTER INSERT
  -- raise trigger -> UPDATE candidate -- always passes this check: by the
  -- time that UPDATE runs, the just-inserted observation is already
  -- visible to this same transaction.
  IF discovery_admissibility_rank(NEW.admissibility) > discovery_admissibility_rank(OLD.admissibility) THEN
    IF NOT EXISTS (
      SELECT 1 FROM discovery_candidate_observations
      WHERE discovery_candidate_id = NEW.id
        AND discovery_admissibility_rank(admissibility) >= discovery_admissibility_rank(NEW.admissibility)
    ) THEN
      RAISE EXCEPTION
        'discovery_candidates.admissibility cannot be raised to % (id=%) without an existing observation of at least that rank',
        NEW.admissibility, OLD.id;
    END IF;
  END IF;

  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'discovery_candidates.last_seen_at cannot move backwards (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_candidates_restrict_mutation
  BEFORE UPDATE OR DELETE ON discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION restrict_discovery_candidate_mutation();

-- ---------------------------------------------------------------------------
-- discovery_candidate_observations: one row per operational sighting of a
-- candidate URL by one provider/feed.
--
-- observed_url preserves exactly what that sighting reported
-- (pre-normalization) for audit -- the same submitted/normalized
-- separation ingestion_jobs/source_items already use; discovery_candidate_id
-- carries the normalized identity via its parent row. Replay identity is
-- deliberately RSS/feed-specific (the partial unique index below, scoped
-- to discovery_feed_id IS NOT NULL) -- this is NOT a general provider-
-- identity rule; do not generalize it. A future non-feed provider inserts
-- a fresh row per sighting until its own replay semantics are designed
-- and approved separately.
-- ---------------------------------------------------------------------------

CREATE TABLE "discovery_candidate_observations" (
  "id" serial PRIMARY KEY NOT NULL,
  "discovery_candidate_id" integer NOT NULL,
  "discovery_provider_id" integer NOT NULL,
  "discovery_feed_id" integer,
  "observed_url" text NOT NULL,
  "admissibility" "discovery_admissibility" NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "discovery_candidate_observations_candidate_fk"
    FOREIGN KEY ("discovery_candidate_id") REFERENCES "discovery_candidates"("id"),
  CONSTRAINT "discovery_candidate_observations_provider_fk"
    FOREIGN KEY ("discovery_provider_id") REFERENCES "discovery_providers"("id"),
  CONSTRAINT "discovery_candidate_observations_feed_fk"
    FOREIGN KEY ("discovery_feed_id") REFERENCES "discovery_feeds"("id"),

  -- Composite-FK target for ingestion_jobs (see below) -- proves an
  -- observation id genuinely belongs to a given candidate id, not merely
  -- that both independently exist. discovery_candidates.id is already a
  -- PRIMARY KEY, so no separate UNIQUE(id) is added there.
  CONSTRAINT "discovery_candidate_observations_id_candidate_unique"
    UNIQUE ("id", "discovery_candidate_id"),

  CONSTRAINT "discovery_candidate_observations_last_seen_not_before_first_seen"
    CHECK ("last_seen_at" >= "first_seen_at")
);

CREATE INDEX "discovery_candidate_observations_candidate_id_idx"
  ON "discovery_candidate_observations" ("discovery_candidate_id");

-- Shaped exactly for the deterministic promotion-origin query:
-- WHERE discovery_candidate_id = $1 AND admissibility = 'eligible'
-- ORDER BY first_seen_at ASC, id ASC LIMIT 1
CREATE INDEX "discovery_candidate_observations_eligible_origin_idx"
  ON "discovery_candidate_observations" ("discovery_candidate_id", "first_seen_at", "id")
  WHERE "admissibility" = 'eligible';

-- RSS/feed-specific replay identity -- see table header. A repeated
-- sighting of the same candidate by the same feed updates this row's
-- last_seen_at only (via the ON CONFLICT ... DO UPDATE below); it is
-- never a second distinct observation.
CREATE UNIQUE INDEX "discovery_candidate_observations_feed_replay_unique"
  ON "discovery_candidate_observations" ("discovery_feed_id", "discovery_candidate_id")
  WHERE "discovery_feed_id" IS NOT NULL;

-- Partial-mutation guard: every observation column is fixed forever at
-- insert time EXCEPT last_seen_at, which may only move forward (a feed
-- replay). No column here is ever "resolved" or enriched the way
-- source_item_links' to_source_item_id is -- an observation's meaning
-- never changes after insert, only how recently it was last seen. DELETE
-- is always rejected.
CREATE OR REPLACE FUNCTION restrict_discovery_candidate_observation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'discovery_candidate_observations rows cannot be deleted (id=%)', OLD.id;
  END IF;

  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'discovery_candidate_observations.last_seen_at cannot move backwards (id=%)', OLD.id;
  END IF;

  IF NEW.discovery_candidate_id IS DISTINCT FROM OLD.discovery_candidate_id
     OR NEW.discovery_provider_id IS DISTINCT FROM OLD.discovery_provider_id
     OR NEW.discovery_feed_id IS DISTINCT FROM OLD.discovery_feed_id
     OR NEW.observed_url IS DISTINCT FROM OLD.observed_url
     OR NEW.admissibility IS DISTINCT FROM OLD.admissibility
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'discovery_candidate_observations rows are observations; only last_seen_at may be updated, forward-only (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_candidate_observations_restrict_mutation
  BEFORE UPDATE OR DELETE ON discovery_candidate_observations
  FOR EACH ROW EXECUTE FUNCTION restrict_discovery_candidate_observation_mutation();

-- The admissibility-raise trigger -- AFTER INSERT ONLY, deliberately never
-- AFTER UPDATE. A feed replay's forward-only last_seen_at UPDATE (see the
-- ON CONFLICT ... DO UPDATE in recordDiscoverySighting()) must NEVER
-- re-evaluate or re-raise the parent candidate's admissibility -- an
-- observation's admissibility is fixed at insert time (enforced by the
-- trigger above), so there is nothing new to fold on a replay. Scoping
-- this trigger to INSERT only is what makes that guarantee structural
-- rather than a matter of the application never happening to call it
-- wrong.
CREATE OR REPLACE FUNCTION raise_discovery_candidate_admissibility()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE discovery_candidates
  SET admissibility = CASE
        WHEN discovery_admissibility_rank(NEW.admissibility) > discovery_admissibility_rank(admissibility)
        THEN NEW.admissibility ELSE admissibility
      END,
      last_seen_at = GREATEST(last_seen_at, NEW.last_seen_at)
  WHERE id = NEW.discovery_candidate_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_candidate_observations_raise_admissibility
  AFTER INSERT ON discovery_candidate_observations
  FOR EACH ROW EXECUTE FUNCTION raise_discovery_candidate_admissibility();

-- ---------------------------------------------------------------------------
-- ingestion_jobs: composite-FK link back to the ledger above.
--
-- Both columns are nullable and NULL for every existing/manual/legacy
-- job, and remain NULL for any future manual submission -- populated
-- together, exactly once, only when claimEligibleCandidatesForPromotion()
-- creates a system job from a promoted candidate.
-- ---------------------------------------------------------------------------

ALTER TABLE "ingestion_jobs"
  ADD COLUMN "discovery_candidate_id" integer,
  ADD COLUMN "discovery_candidate_observation_id" integer;

ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_discovery_candidate_id_fk"
  FOREIGN KEY ("discovery_candidate_id") REFERENCES "discovery_candidates"("id");

-- The composite FK itself -- proves discovery_candidate_observation_id
-- genuinely belongs to discovery_candidate_id, not merely that both ids
-- independently exist somewhere.
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_candidate_observation_composite_fk"
  FOREIGN KEY ("discovery_candidate_observation_id", "discovery_candidate_id")
  REFERENCES "discovery_candidate_observations" ("id", "discovery_candidate_id");

ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_discovery_candidate_pairing"
  CHECK (("discovery_candidate_id" IS NULL) = ("discovery_candidate_observation_id" IS NULL));

-- AUTHORITATIVE concurrency guard for candidate promotion (same pattern as
-- migration 0012's ingestion_jobs_discovery_feed_normalized_url_unique): a
-- plain unique index permits any number of NULL rows (every manual/legacy
-- job) but rejects a second non-NULL value, so two concurrent promotion
-- attempts racing on the same candidate can never both insert a job for
-- it. This index remains the authoritative database guard regardless of
-- how the application chooses to observe a conflict: claimEligibleCandidatesForPromotion()
-- inserts via unqualified `ON CONFLICT DO NOTHING`, so a losing racer's
-- INSERT returns no row rather than raising a 23505 -- there is
-- deliberately no caught-exception control flow here (a raised
-- constraint violation would abort the whole surrounding transaction,
-- which spans multiple candidates). This also directly enforces "one
-- candidate may be associated with at most one ingestion job."
CREATE UNIQUE INDEX "ingestion_jobs_discovery_candidate_id_unique"
  ON "ingestion_jobs" ("discovery_candidate_id");

-- General-purpose (NOT partial, unlike the two existing normalized_url
-- indexes on this table) -- the promotion-claim query deliberately checks
-- whether a normalized_url already exists among ingestion_jobs rows of
-- ANY status and ANY discovery_provider_id, so a candidate whose URL was
-- already historically ingested (manually, or by an old feed run) is
-- never repeatedly reclaimed for promotion.
CREATE INDEX "ingestion_jobs_normalized_url_idx" ON "ingestion_jobs" ("normalized_url");

-- =============================================================================
-- Security: explicit per-table lockdown for the two new tables (standing
-- rule since migration 0007). No REVOKE/GRANT changes needed for the
-- ingestion_jobs columns/indexes above -- they inherit that table's
-- existing grants automatically (same as migration 0012's discovery_feed_id).
-- =============================================================================

REVOKE ALL ON "discovery_candidates" FROM anon, authenticated;
REVOKE ALL ON "discovery_candidate_observations" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "discovery_candidates_id_seq" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "discovery_candidate_observations_id_seq" FROM anon, authenticated;

ALTER TABLE "discovery_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discovery_candidate_observations" ENABLE ROW LEVEL SECURITY;
-- No permissive policies -- deny-by-default, same as every table since
-- migration 0006. app_role/admin_role bypass RLS; their actual access is
-- governed entirely by the GRANT statements below.

-- --- app_role: deliberately NO grants on either table -- purely
-- operational/pipeline data with no public-facing purpose, same
-- reasoning as discovery_providers/ingestion_jobs (migration 0007).

-- --- admin_role: SELECT/INSERT/UPDATE only -- NO DELETE grant. Both
-- triggers above reject every DELETE regardless of role, so admin_role
-- has no legitimate use for a DELETE grant and isn't given one (same
-- precedent as source_item_links, migration 0026).
GRANT SELECT, INSERT, UPDATE ON "discovery_candidates" TO admin_role;
GRANT SELECT, INSERT, UPDATE ON "discovery_candidate_observations" TO admin_role;
GRANT USAGE ON SEQUENCE "discovery_candidates_id_seq" TO admin_role;
GRANT USAGE ON SEQUENCE "discovery_candidate_observations_id_seq" TO admin_role;
