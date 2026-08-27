-- =============================================================================
-- Migration 0025: Phase 5 PR 8b -- human review of analyse_provenance
-- proposed edges.
--
-- admin_decisions.ai_result_id identifies a whole analyse_provenance
-- result, not one proposed edge within it, so it cannot by itself record a
-- partial approval/edit/rejection -- the identical gap claim_comparison_reviews
-- (0022) closed for PR7's compare_claims assessments. This append-only
-- bridge identifies one recommendation by (ai_result_id, edge_index) and
-- records the human decision plus, for an approval only, an immutable
-- snapshot of the EFFECTIVE directed relationship.
--
-- DURABLE ROW POLICY DIVERGENCE FROM PR7 (see docs/architecture.md): on
-- approval here, the resulting source_relationships row NEVER receives
-- AI-authored confidence or evidence_note -- those columns stay NULL on
-- that row unless an admin explicitly supplies them, and the AI's own
-- confidence/reasoning/distinctEvidenceSummary remain readable only via
-- ai_results and this review row's own snapshot metadata is intentionally
-- NOT stored as columns here either (unlike claim_comparison_reviews, which
-- has no equivalent of confidence at all on claim_relationships to begin
-- with). This bridge's snapshot columns record only what
-- source_relationships itself can hold: the two source item ids and the
-- relationship type.
--
-- WHY materialized_relationship_id IS NOT A FOREIGN KEY
-- -----------------------------------------------------
-- source_relationships rows are genuinely hard-deletable
-- (deleteSourceRelationship in src/db/mutations/provenance.ts issues a real
-- DELETE) -- unlike source_items and claims, which no application code path
-- ever hard-deletes. Combined with this table's immutability trigger, the
-- same reasoning migration 0022 already gave for claim_comparison_reviews
-- applies identically here: any FK action that MUTATES the referencing row
-- (SET NULL, CASCADE) is incompatible with a row-level immutability
-- trigger, and RESTRICT would make an AI-approved relationship
-- undeletable. This is a plain integer historical identifier with no
-- referential integrity; approved_source_item_id_a/_b remain real foreign
-- keys, since source_items is never hard-deleted by any application code
-- path.
--
-- NO CANONICALIZATION CHECK: unlike claim_comparison_reviews_symmetric_
-- snapshot_canonical, provenance relationships are NEVER canonicalized --
-- source_item_id_a is always the subject, source_item_id_b the object (see
-- src/lib/provenanceDirection.ts) -- so (A,B) and (B,A) are different facts
-- that may both legitimately exist as separate approved snapshot rows.
-- There is deliberately no ordering constraint on approved_source_item_id_a
-- vs approved_source_item_id_b.
-- =============================================================================

CREATE TABLE "source_relationship_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_result_id" integer NOT NULL,
  "edge_index" integer NOT NULL,
  "admin_decision_id" integer NOT NULL,

  -- Approval-only snapshot. All four NULL together for a rejection.
  "approved_source_item_id_a" integer,
  "approved_source_item_id_b" integer,
  "approved_relationship_type" "source_relationship_type",
  "materialized_relationship_id" integer,          -- deliberately NOT an FK; see header
  "relationship_was_newly_created" boolean,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "source_relationship_reviews_edge_index_nonnegative"
    CHECK ("edge_index" >= 0),

  -- All-or-nothing: a review is either an approval carrying a complete
  -- snapshot, or a rejection carrying none of it. No partial states.
  CONSTRAINT "source_relationship_reviews_approval_snapshot_complete" CHECK (
    (
      "approved_source_item_id_a" IS NULL AND "approved_source_item_id_b" IS NULL
      AND "approved_relationship_type" IS NULL
      AND "materialized_relationship_id" IS NULL
      AND "relationship_was_newly_created" IS NULL
    )
    OR
    (
      "approved_source_item_id_a" IS NOT NULL AND "approved_source_item_id_b" IS NOT NULL
      AND "approved_relationship_type" IS NOT NULL
      AND "materialized_relationship_id" IS NOT NULL
      AND "relationship_was_newly_created" IS NOT NULL
    )
  ),

  -- Mirrors source_relationships_no_self_link.
  CONSTRAINT "source_relationship_reviews_snapshot_no_self_link"
    CHECK ("approved_source_item_id_a" IS NULL
           OR "approved_source_item_id_a" <> "approved_source_item_id_b"),

  CONSTRAINT "source_relationship_reviews_ai_result_id_ai_results_id_fk"
    FOREIGN KEY ("ai_result_id") REFERENCES "ai_results"("id"),
  -- Named "..._admin_decision_fk" rather than the fuller
  -- "..._admin_decision_id_admin_decisions_id_fk" pattern used elsewhere in
  -- this file/project: the fuller form exceeds PostgreSQL's 63-character
  -- identifier limit and would be silently truncated -- same reasoning
  -- migration 0022 documented for claim_comparison_reviews_admin_decision_fk.
  CONSTRAINT "source_relationship_reviews_admin_decision_fk"
    FOREIGN KEY ("admin_decision_id") REFERENCES "admin_decisions"("id"),
  CONSTRAINT "source_relationship_reviews_approved_source_item_id_a_fk"
    FOREIGN KEY ("approved_source_item_id_a") REFERENCES "source_items"("id"),
  CONSTRAINT "source_relationship_reviews_approved_source_item_id_b_fk"
    FOREIGN KEY ("approved_source_item_id_b") REFERENCES "source_items"("id")
);

CREATE UNIQUE INDEX "source_relationship_reviews_edge_unique"
  ON "source_relationship_reviews" ("ai_result_id", "edge_index");
CREATE UNIQUE INDEX "source_relationship_reviews_decision_unique"
  ON "source_relationship_reviews" ("admin_decision_id");
CREATE INDEX "source_relationship_reviews_materialized_relationship_idx"
  ON "source_relationship_reviews" ("materialized_relationship_id");

-- This review ledger is historical evidence of a human decision. It must
-- be append-only exactly like the status histories, the admin audit log,
-- and claim_comparison_reviews; a mistake is handled by subsequent normal
-- source-relationship administration, not by erasing the original review
-- record.
CREATE TRIGGER trg_source_relationship_reviews_immutable
  BEFORE UPDATE OR DELETE ON source_relationship_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();

ALTER TABLE public.source_relationship_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON source_relationship_reviews TO admin_role;
