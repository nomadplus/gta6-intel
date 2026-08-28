-- =============================================================================
-- Migration 0026: Phase 6 prerequisite -- deterministic outbound-link
-- extraction from ingested HTML, as a durable OBSERVATION table.
--
-- source_item_links is NOT an epistemic/inference table -- it never asserts
-- citation, derivative, or any other relationship. It records only what was
-- structurally and mechanically true of one fetched document: "this item's
-- HTML contained an <a> tag whose resolved target was this URL, at this DOM
-- position, with this anchor text/context, structurally placed in
-- content-like or chrome-like markup, on the same site or a different one."
-- Whether that observation supports a genuine provenance relationship is
-- decided entirely elsewhere -- by analyse_provenance (AI, proposal-only) or
-- by a human directly via the existing source_relationships admin form.
-- Never conflate the two: "placement"/"is_same_site" below are structural
-- facts, not conclusions -- there is deliberately no column here named
-- anything like "is_citation" or "likely_citation".
--
-- OBSERVATION VS. ENRICHMENT
-- --------------------------
-- Every column except (to_source_item_id, resolved_at) is fixed forever at
-- insert time -- it describes what this fetch actually found and must never
-- be rewritten (Section 4 of the project instructions: historical
-- information must not silently disappear or be overwritten). Exactly one
-- transition is permitted after insert: to_source_item_id may move from NULL
-- to a real id, exactly once, together with resolved_at, when a later
-- ingestion event makes the link's target unambiguously resolvable (see
-- restrict_source_item_link_mutation() below). This is enrichment of a
-- previously-unknown pointer, not a rewrite of the observation -- the
-- observation (target_url, normalized_target_url, anchor_text, context,
-- rel_attribute, link_position, placement, is_same_site, ingestion_job_id)
-- never changes.
--
-- WHY UNRESOLVED LINKS ARE KEPT (not just resolved ones)
-- -------------------------------------------------------
-- A freshly-fetched page overwhelmingly links to URLs this project hasn't
-- ingested yet. Discarding those would throw away exactly the forward-
-- looking discovery signal Phase 6 exists to use -- an unresolved link is a
-- candidate for future autonomous discovery, not noise. They remain subject
-- to the same MAX_EXTRACTED_LINKS_PER_JOB (200) hard cap as everything else.
--
-- WHY NO raw_href
-- ----------------
-- An earlier draft of this design kept the literal, pre-resolution href for
-- auditability. Rejected: target_url/normalized_target_url already carry
-- the useful resolved and identity-normalized forms, and an href can embed
-- tracking IDs, tokens, or other incidental garbage that has no
-- justification for a second stored copy in this phase.
--
-- WHY NO UNIQUENESS ON (from_source_item_id, to_source_item_id)
-- ----------------------------------------------------------------
-- A single article can genuinely link the same target twice (once inline,
-- once in a "related stories" block) -- each occurrence is a distinct
-- observation at a distinct link_position, not a duplicate to collapse.
--
-- PROVIDER-AGNOSTIC BY DESIGN
-- ----------------------------
-- Nothing here assumes the source item is a newspaper article. from/to
-- reference source_items rows regardless of what ingestion adapter
-- eventually produced them (RSS, forum thread, social post, etc) -- future
-- Phase 6 discovery providers are expected to feed this same table.
-- =============================================================================

CREATE TYPE "source_item_link_placement" AS ENUM ('content', 'chrome', 'ambiguous');

CREATE TABLE "source_item_links" (
  "id" serial PRIMARY KEY NOT NULL,

  "from_source_item_id" integer NOT NULL,
  "to_source_item_id" integer,                    -- NULL until deterministically resolved (see below)

  "target_url" varchar(2048) NOT NULL,             -- resolved absolute http(s) URL, fragment stripped; a link whose resolved/normalized URL exceeds 2048 chars is never inserted at all (dropped at extraction, never truncated)
  "normalized_target_url" varchar(2048) NOT NULL,  -- via the existing normalizeUrl() -- same identity policy as source_items.normalized_url; never a second, ad hoc normalization implementation

  "anchor_text" varchar(300),
  "link_context_snippet" varchar(300),             -- bounded, whitespace-normalized VISIBLE TEXT around the link -- never serialized HTML, never full-article (the no-full-article-body invariant remains in force)
  "rel_attribute" varchar(200),

  "link_position" integer NOT NULL,                -- 0-indexed encounter order among ALL <a> tags in this fetch, assigned before any filtering/capping
  "placement" "source_item_link_placement" NOT NULL,
  "is_same_site" boolean NOT NULL,

  "ingestion_job_id" integer NOT NULL,             -- the fetch that produced this observation -- its provenance
  "extracted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,          -- set only together with to_source_item_id, once
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "source_item_links_no_self_link"
    CHECK ("to_source_item_id" IS NULL OR "from_source_item_id" <> "to_source_item_id"),
  CONSTRAINT "source_item_links_link_position_nonnegative"
    CHECK ("link_position" >= 0),
  CONSTRAINT "source_item_links_resolved_at_requires_target"
    CHECK (("to_source_item_id" IS NULL) = ("resolved_at" IS NULL)),

  CONSTRAINT "source_item_links_from_source_item_fk"
    FOREIGN KEY ("from_source_item_id") REFERENCES "source_items"("id"),
  CONSTRAINT "source_item_links_to_source_item_fk"
    FOREIGN KEY ("to_source_item_id") REFERENCES "source_items"("id"),
  CONSTRAINT "source_item_links_ingestion_job_fk"
    FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id")
);

-- Idempotency/occurrence guard -- link_position is assigned deterministically
-- per fetch (an array index, effectively), so this is trivially satisfied by
-- correct code; it exists to catch an accidental double-insert (e.g. a
-- retried confirmation transaction), not to prevent any legitimate case.
-- Multiple different positions targeting the SAME url/item remain fully
-- allowed -- no uniqueness on (from_source_item_id, to_source_item_id).
CREATE UNIQUE INDEX "source_item_links_job_position_unique"
  ON "source_item_links" ("ingestion_job_id", "link_position");

CREATE INDEX "source_item_links_from_idx"
  ON "source_item_links" ("from_source_item_id");

CREATE INDEX "source_item_links_to_idx"
  ON "source_item_links" ("to_source_item_id")
  WHERE "to_source_item_id" IS NOT NULL;

-- The retroactive-resolution algorithm's exact lookup shape: "find
-- unresolved rows whose target matches this URL" -- a partial index scoped
-- to exactly the rows that query ever touches, not a general-purpose index
-- on a column that is mostly resolved over time.
CREATE INDEX "source_item_links_unresolved_target_idx"
  ON "source_item_links" ("normalized_target_url")
  WHERE "to_source_item_id" IS NULL;

-- ---------------------------------------------------------------------------
-- Partial-immutability trigger. Unlike reject_status_history_mutation()
-- (blanket, used by every other append-only table in this project: the two
-- status history ledgers, admin_audit_log, claim_comparison_reviews,
-- source_relationship_reviews), this table permits exactly ONE narrow UPDATE
-- shape: to_source_item_id transitioning NULL -> NOT NULL together with
-- resolved_at transitioning NULL -> NOT NULL, with every observation column
-- byte-identical to its prior value. Every other UPDATE, and every DELETE,
-- is rejected -- including a no-op UPDATE (OLD.to_source_item_id already
-- NOT NULL blocks any further UPDATE outright, whether or not the new
-- values would coincidentally match).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION restrict_source_item_link_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source_item_links rows are append-only observations and cannot be deleted (id=%)', OLD.id;
  END IF;

  -- Already resolved: no further UPDATE of any kind is permitted, including
  -- a second "resolution" attempt or a no-op.
  IF OLD.to_source_item_id IS NOT NULL OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'source_item_links.to_source_item_id/resolved_at may only be resolved once (id=%)', OLD.id;
  END IF;

  -- The only legal transition: both NULL -> both NOT NULL, together.
  IF NOT (NEW.to_source_item_id IS NOT NULL AND NEW.resolved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'source_item_links rows are observations; the only permitted UPDATE resolves BOTH to_source_item_id and resolved_at together, from NULL to a value (id=%)', OLD.id;
  END IF;

  -- Every observation column must be byte-identical to its prior value.
  IF NEW.from_source_item_id IS DISTINCT FROM OLD.from_source_item_id
     OR NEW.target_url IS DISTINCT FROM OLD.target_url
     OR NEW.normalized_target_url IS DISTINCT FROM OLD.normalized_target_url
     OR NEW.anchor_text IS DISTINCT FROM OLD.anchor_text
     OR NEW.link_context_snippet IS DISTINCT FROM OLD.link_context_snippet
     OR NEW.rel_attribute IS DISTINCT FROM OLD.rel_attribute
     OR NEW.link_position IS DISTINCT FROM OLD.link_position
     OR NEW.placement IS DISTINCT FROM OLD.placement
     OR NEW.is_same_site IS DISTINCT FROM OLD.is_same_site
     OR NEW.ingestion_job_id IS DISTINCT FROM OLD.ingestion_job_id
     OR NEW.extracted_at IS DISTINCT FROM OLD.extracted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'source_item_links rows are observations; only the one-time to_source_item_id/resolved_at resolution may be updated (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_source_item_links_restrict_mutation
  BEFORE UPDATE OR DELETE ON source_item_links
  FOR EACH ROW EXECUTE FUNCTION restrict_source_item_link_mutation();

ALTER TABLE public.source_item_links ENABLE ROW LEVEL SECURITY;

-- Admin-only, least privilege: no app_role grant at all (matching
-- discovery_providers/ingestion_jobs' existing "purely operational,
-- zero app_role access" precedent from migration 0007). No DELETE grant --
-- this table's design forbids deletion entirely (the trigger above rejects
-- every DELETE regardless of role), so admin_role has no legitimate use for
-- it and isn't given it.
GRANT SELECT, INSERT, UPDATE ON source_item_links TO admin_role;
GRANT USAGE ON SEQUENCE "source_item_links_id_seq" TO admin_role;
