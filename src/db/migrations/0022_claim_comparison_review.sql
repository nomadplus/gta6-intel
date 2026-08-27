-- =============================================================================
-- Migration 0022: Phase 5 PR 7 -- human review of compare_claims
-- assessments.
--
-- admin_decisions.ai_result_id identifies a whole compare_claims result,
-- not one assessment within it, so it cannot by itself record a partial
-- approval/edit/rejection -- the identical gap claim_proposal_reviews
-- (0016) closed for PR5. This append-only bridge identifies one
-- recommendation by (ai_result_id, assessment_index) and records the
-- human decision plus, for an approval or an edited approval only, an
-- immutable snapshot of the EFFECTIVE relationship.
--
-- WHY materialized_relationship_id IS NOT A FOREIGN KEY
-- -----------------------------------------------------
-- claim_relationships rows are genuinely deletable (deleteClaimRelationship
-- in src/db/mutations/claimRelationships.ts issues a real DELETE) -- unlike
-- claims, which no application code path ever hard-deletes. Combined with
-- this table's immutability trigger, that leaves no workable FK action:
--
--   ON DELETE SET NULL  -- would UPDATE this row, which the BEFORE UPDATE
--                          trigger rejects, making the relationship
--                          effectively undeletable. The trigger would win,
--                          silently converting a deletable row into a
--                          permanent one.
--   ON DELETE RESTRICT  -- blocks deletion outright: an AI-approved
--                          relationship could never be removed by an admin.
--   ON DELETE CASCADE   -- would DELETE this review row, destroying the
--                          historical record (and is likewise rejected by
--                          the trigger).
--
-- General rule: any referential action that MUTATES the referencing row is
-- incompatible with a row-level immutability trigger. Only NO ACTION /
-- RESTRICT are compatible, and RESTRICT is unacceptable here on product
-- grounds.
--
-- INTEGRITY TRADE-OFF, STATED EXPLICITLY: materialized_relationship_id is a
-- plain integer historical identifier with NO referential integrity. After
-- a relationship is deleted it becomes a dangling id. Three things make
-- that acceptable rather than sloppy:
--   1. The columns beside it (approved_claim_id_a / _b /
--      approved_relationship_type) are a COMPLETE, self-describing
--      snapshot of the effective relationship. The historical fact
--      survives intact without needing to dereference the id at all; the
--      id is a convenience pointer, not the record.
--   2. Postgres serial sequences never reuse a value, so a dangling id can
--      never silently resolve to a DIFFERENT relationship. It resolves to
--      exactly one thing or to nothing.
--   3. The deletion itself remains fully auditable: deleteClaimRelationship
--      writes an 'unlink'/'claim_relationship' admin_audit_log entry
--      carrying the same id.
-- Any reader joining on this column MUST tolerate a miss (LEFT JOIN, and
-- treat a null match as "the relationship was subsequently removed").
--
-- approved_claim_id_a / approved_claim_id_b ARE plain foreign keys to
-- claims.id -- verified safe by direct inspection of every .delete() call
-- in src/db/mutations/ and src/app/: claims are never hard-deleted by any
-- application code path (only claim_topics, claim_sources,
-- source_relationships, claim_relationships, and claim_evidence rows
-- are). The default NO ACTION delete behavior on these two FKs would
-- BLOCK a hypothetical future claim deletion rather than mutating this
-- row, which is compatible with the immutability trigger below (unlike
-- SET NULL/CASCADE).
--
-- The snapshot stores the EFFECTIVE stored tuple -- after direction
-- resolution AND after symmetric canonicalization -- never the raw
-- focus/other orientation the AI proposed or the admin submitted. The
-- claim_comparison_reviews_symmetric_snapshot_canonical CHECK below
-- enforces that at the database layer rather than trusting the
-- application to have done it correctly.
-- =============================================================================

CREATE TABLE "claim_comparison_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "ai_result_id" integer NOT NULL,
  "assessment_index" integer NOT NULL,
  "admin_decision_id" integer NOT NULL,

  -- Approval-only snapshot. All five NULL together for a rejection.
  "approved_claim_id_a" integer,
  "approved_claim_id_b" integer,
  "approved_relationship_type" "claim_relationship_type",
  "materialized_relationship_id" integer,          -- deliberately NOT an FK; see header
  "relationship_was_newly_created" boolean,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "claim_comparison_reviews_assessment_index_nonnegative"
    CHECK ("assessment_index" >= 0),

  -- All-or-nothing: a review is either an approval carrying a complete
  -- snapshot, or a rejection carrying none of it. No partial states.
  CONSTRAINT "claim_comparison_reviews_approval_snapshot_complete" CHECK (
    (
      "approved_claim_id_a" IS NULL AND "approved_claim_id_b" IS NULL
      AND "approved_relationship_type" IS NULL
      AND "materialized_relationship_id" IS NULL
      AND "relationship_was_newly_created" IS NULL
    )
    OR
    (
      "approved_claim_id_a" IS NOT NULL AND "approved_claim_id_b" IS NOT NULL
      AND "approved_relationship_type" IS NOT NULL
      AND "materialized_relationship_id" IS NOT NULL
      AND "relationship_was_newly_created" IS NOT NULL
    )
  ),

  -- Mirrors claim_relationships_no_self_link.
  CONSTRAINT "claim_comparison_reviews_snapshot_no_self_link"
    CHECK ("approved_claim_id_a" IS NULL
           OR "approved_claim_id_a" <> "approved_claim_id_b"),

  -- The snapshot must be the EFFECTIVE canonical form, not raw
  -- focus/other orientation: for the three symmetric types,
  -- claim_relationships stores the lower id as claim_id_a (see
  -- src/lib/relationshipCanonicalization.ts), so this snapshot must too.
  -- Directional types (subsumes, refines) are exempt -- their ordering
  -- carries meaning and is stored exactly as resolved.
  CONSTRAINT "claim_comparison_reviews_symmetric_snapshot_canonical" CHECK (
    "approved_relationship_type" IS NULL
    OR "approved_relationship_type" NOT IN ('equivalent', 'related', 'contradicts')
    OR "approved_claim_id_a" < "approved_claim_id_b"
  ),

  CONSTRAINT "claim_comparison_reviews_ai_result_id_ai_results_id_fk"
    FOREIGN KEY ("ai_result_id") REFERENCES "ai_results"("id"),
  -- Named "..._admin_decision_fk" rather than the fuller
  -- "..._admin_decision_id_admin_decisions_id_fk" pattern used elsewhere
  -- in this file/project: at 64 characters, the fuller form exceeds
  -- PostgreSQL's 63-character identifier limit and would be silently
  -- truncated. This shorter name stays under that limit exactly.
  CONSTRAINT "claim_comparison_reviews_admin_decision_fk"
    FOREIGN KEY ("admin_decision_id") REFERENCES "admin_decisions"("id"),
  CONSTRAINT "claim_comparison_reviews_approved_claim_id_a_claims_id_fk"
    FOREIGN KEY ("approved_claim_id_a") REFERENCES "claims"("id"),
  CONSTRAINT "claim_comparison_reviews_approved_claim_id_b_claims_id_fk"
    FOREIGN KEY ("approved_claim_id_b") REFERENCES "claims"("id")
);

CREATE UNIQUE INDEX "claim_comparison_reviews_assessment_unique"
  ON "claim_comparison_reviews" ("ai_result_id", "assessment_index");
CREATE UNIQUE INDEX "claim_comparison_reviews_decision_unique"
  ON "claim_comparison_reviews" ("admin_decision_id");
CREATE INDEX "claim_comparison_reviews_materialized_relationship_idx"
  ON "claim_comparison_reviews" ("materialized_relationship_id");

-- This review ledger is historical evidence of a human decision. It must
-- be append-only exactly like the status histories, the admin audit log,
-- and claim_proposal_reviews; a mistake is handled by subsequent normal
-- claim/relationship administration, not by erasing the original review
-- record.
CREATE TRIGGER trg_claim_comparison_reviews_immutable
  BEFORE UPDATE OR DELETE ON claim_comparison_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_status_history_mutation();

ALTER TABLE public.claim_comparison_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON claim_comparison_reviews TO admin_role;
