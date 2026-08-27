/**
 * Phase 5 PR 7 regression check: the human review of one compare_claims
 * result's assessments -- the core of this PR. Exercises the real,
 * guarded approve/approve-with-changes/reject mutations
 * (src/db/mutations/claimComparisonReviews.ts) and the
 * insertClaimRelationshipTx extraction (src/db/mutations/claimRelationships.ts)
 * against a local Postgres database. No AI provider call happens
 * anywhere in this file.
 *
 * Proves:
 *   - directional semantics survive end-to-end: persisted AI output ->
 *     approval -> the ACTUAL stored (claim_id_a, claim_id_b,
 *     relationship_type), for both directions of both directional types
 *   - symmetric-type canonicalization (lower id as claim_id_a)
 *     regardless of which claim was the focus
 *   - the immutable snapshot always matches the row insertClaimRelationshipTx
 *     actually returned, never the raw pre-canonicalization orientation
 *   - approving a recommendation that resolves to an ALREADY-EXISTING
 *     relationship reuses that row (no duplicate, unmodified) and does
 *     NOT emit a fake create/claim_relationship audit entry
 *   - approving a recommendation that resolves to a genuinely NEW
 *     relationship DOES emit exactly one create/claim_relationship audit entry
 *   - rejection creates a decision + bridge row but zero
 *     claim_relationships rows and an all-NULL snapshot
 *   - NEITHER status-history ledger ever gains a row from any review path
 *   - the otherClaimId tamper barrier rejects a submitted id that doesn't
 *     match this assessment's own persisted output
 *   - approve-with-changes records action='edit' and materializes the
 *     ADMIN's type/direction, not the AI's
 *   - a double review is blocked, and a losing concurrent approval's
 *     relationship insert is rolled back (no orphan relationship survives)
 *   - claim_comparison_reviews is append-only: UPDATE and DELETE are both
 *     rejected by its trigger
 *   - deletion survivability: after approval, deleteClaimRelationship
 *     succeeds, the bridge row survives UNCHANGED, and
 *     materialized_relationship_id becomes a (harmless) dangling id
 *
 * Run with: npx tsx --conditions=react-server src/checks/claimRelationshipReview.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  aiJobs,
  aiResults,
  claims,
  claimRelationships,
  claimComparisonReviews,
  adminDecisions,
  adminAuditLog,
  claimInvestigationStatusHistory,
  claimDevelopmentOutcomeHistory,
} from "../db/schema";
import {
  approveClaimComparison,
  approveClaimComparisonWithChanges,
  rejectClaimComparison,
  ComparisonAlreadyReviewedError,
  OtherClaimNotAPersistedAssessmentError,
} from "../db/mutations/claimComparisonReviews";
import { deleteClaimRelationship } from "../db/mutations/claimRelationships";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
}

const SEEDED_PROJECT_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this check performs real database writes.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set. This local-only check needs the fake admin session.");
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  async function createTestClaim(statement: string): Promise<number> {
    const [row] = await db.insert(claims).values({ projectId: SEEDED_PROJECT_ID, slug: `pr7-review-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return row.id;
  }

  /** One genuine succeeded compare_claims ai_job + ai_result, with a real structured_output containing the given assessments at their array index. */
  async function createCompareClaimsResult(focusClaimId: number, assessments: unknown[]): Promise<number> {
    const [job] = await db
      .insert(aiJobs)
      .values({ operation: "compare_claims", provider: "fake", model: "test-model", status: "succeeded", comparisonClaimId: focusClaimId, completedAt: new Date() })
      .returning();
    const [result] = await db.insert(aiResults).values({ aiJobId: job.id, structuredOutput: { assessments } }).returning();
    return result.id;
  }

  async function loadRelationship(id: number) {
    const [row] = await db.select().from(claimRelationships).where(eq(claimRelationships.id, id));
    return row;
  }

  async function loadReview(aiResultId: number, assessmentIndex: number) {
    const [row] = await db
      .select()
      .from(claimComparisonReviews)
      .where(and(eq(claimComparisonReviews.aiResultId, aiResultId), eq(claimComparisonReviews.assessmentIndex, assessmentIndex)));
    return row;
  }

  async function loadDecision(id: number) {
    const [row] = await db.select().from(adminDecisions).where(eq(adminDecisions.id, id));
    return row;
  }

  async function countAuditEntries(entityType: "claim_relationship" | "claim_comparison_review", entityId: number): Promise<number> {
    const rows = await db.select({ id: adminAuditLog.id }).from(adminAuditLog).where(and(eq(adminAuditLog.entityType, entityType), eq(adminAuditLog.entityId, entityId)));
    return rows.length;
  }

  async function countLedgerRows(): Promise<{ investigation: number; development: number }> {
    const investigation = await db.select({ id: claimInvestigationStatusHistory.id }).from(claimInvestigationStatusHistory);
    const development = await db.select({ id: claimDevelopmentOutcomeHistory.id }).from(claimDevelopmentOutcomeHistory);
    return { investigation: investigation.length, development: development.length };
  }

  try {
    console.log("=== claim-comparison review (Phase 5 PR 7) -- DB only, no AI call ===\n");

    const ledgerCountsBeforeAll = await countLedgerRows();

    // --- directional semantics 4-way matrix: refines/focus_to_other -------
    {
      const focus = await createTestClaim("The game is set in a Miami-inspired city.");
      const other = await createTestClaim("The fictional city is called Vice City.");
      const aiResultId = await createCompareClaimsResult(focus, [
        { otherClaimId: other, relationshipType: "refines", direction: "focus_to_other", confidence: 0.8, reasoning: "fixture" },
      ]);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);

      assert(relationship.claimIdA === focus && relationship.claimIdB === other, "refines/focus_to_other: stored claim_id_a is the FOCUS claim, claim_id_b is the OTHER claim");
      assert(relationship.relationshipType === "refines", "refines/focus_to_other: stored relationship_type is 'refines'");
      assert(review.approvedClaimIdA === relationship.claimIdA && review.approvedClaimIdB === relationship.claimIdB, "refines/focus_to_other: bridge snapshot matches the stored row exactly");
    }

    // --- directional semantics: refines/other_to_focus ---------------------
    {
      const focus = await createTestClaim("The map has a specific sub-area with a swamp.");
      const other = await createTestClaim("The game world includes many distinct biomes.");
      const aiResultId = await createCompareClaimsResult(focus, [
        { otherClaimId: other, relationshipType: "refines", direction: "other_to_focus", confidence: 0.75, reasoning: "fixture" },
      ]);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);

      assert(relationship.claimIdA === other && relationship.claimIdB === focus, "refines/other_to_focus: stored claim_id_a is the OTHER claim, claim_id_b is the FOCUS claim (REVERSED from the previous case)");
      assert(review.approvedClaimIdA === other && review.approvedClaimIdB === focus, "refines/other_to_focus: bridge snapshot reflects the reversed orientation");
    }

    // --- directional semantics: subsumes/focus_to_other ---------------------
    {
      const focus = await createTestClaim("The game world includes many distinct biomes (subsumes fixture).");
      const other = await createTestClaim("There is a specific swamp sub-area (subsumes fixture).");
      const aiResultId = await createCompareClaimsResult(focus, [
        { otherClaimId: other, relationshipType: "subsumes", direction: "focus_to_other", confidence: 0.7, reasoning: "fixture" },
      ]);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);

      assert(relationship.claimIdA === focus && relationship.claimIdB === other, "subsumes/focus_to_other: stored claim_id_a is the FOCUS claim, claim_id_b is the OTHER claim");
      assert(relationship.relationshipType === "subsumes", "subsumes/focus_to_other: stored relationship_type is 'subsumes'");
    }

    // --- directional semantics: subsumes/other_to_focus ---------------------
    {
      const focus = await createTestClaim("A specific swamp sub-area exists (subsumes-reverse fixture).");
      const other = await createTestClaim("The game world includes many distinct biomes (subsumes-reverse fixture).");
      const aiResultId = await createCompareClaimsResult(focus, [
        { otherClaimId: other, relationshipType: "subsumes", direction: "other_to_focus", confidence: 0.7, reasoning: "fixture" },
      ]);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);

      assert(relationship.claimIdA === other && relationship.claimIdB === focus, "subsumes/other_to_focus: stored claim_id_a is the OTHER claim, claim_id_b is the FOCUS claim (REVERSED)");
    }

    // --- symmetric-type canonicalization: lower id is ALWAYS claim_id_a ---
    {
      // Create 'other' first so its id is guaranteed LOWER than focus's.
      const other = await createTestClaim("Same underlying fact, worded one way (canonicalization fixture).");
      const focus = await createTestClaim("Same underlying fact, worded another way (canonicalization fixture).");
      assert(other < focus, "setup: 'other' claim id is lower than 'focus' claim id, so canonicalization is genuinely exercised");

      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "equivalent", confidence: 0.9, reasoning: "fixture" }]);
      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);

      assert(relationship.claimIdA === other && relationship.claimIdB === focus, "symmetric canonicalization: the LOWER id ('other', not 'focus') is stored as claim_id_a, regardless of which was the focus claim");
      assert(review.approvedClaimIdA === other && review.approvedClaimIdB === focus, "symmetric canonicalization: bridge snapshot matches the CANONICAL stored orientation, not raw focus/other orientation");
    }

    // --- created_by is ALWAYS 'human' for an approved recommendation -------
    {
      const focus = await createTestClaim("created_by fixture focus claim.");
      const other = await createTestClaim("created_by fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);
      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationship = await loadRelationship(review.materializedRelationshipId!);
      assert(relationship.createdBy === "human", `LOCKED DECISION: created_by is 'human' for an AI-recommended, human-approved relationship (got '${relationship.createdBy}')`);
    }

    // --- idempotent reuse: pre-existing relationship, no duplicate, no fake audit ---
    {
      const focus = await createTestClaim("Idempotent-reuse fixture focus claim.");
      const other = await createTestClaim("Idempotent-reuse fixture other claim.");
      const [lowerId, higherId] = focus < other ? [focus, other] : [other, focus];
      const [existing] = await db
        .insert(claimRelationships)
        .values({ claimIdA: lowerId, claimIdB: higherId, relationshipType: "related", createdBy: "human", confidence: "0.400" })
        .returning();

      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);

      const preAuditCount = await countAuditEntries("claim_relationship", existing.id);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });

      assert(review.materializedRelationshipId === existing.id, "idempotent reuse: the bridge records the EXISTING relationship's id, not a new one");
      assert(review.relationshipWasNewlyCreated === false, "idempotent reuse: relationship_was_newly_created is false");

      const allMatching = await db
        .select()
        .from(claimRelationships)
        .where(and(eq(claimRelationships.claimIdA, lowerId), eq(claimRelationships.claimIdB, higherId), eq(claimRelationships.relationshipType, "related")));
      assert(allMatching.length === 1, `idempotent reuse: exactly ONE relationship row exists for this (pair, type) after approval -- no duplicate (got ${allMatching.length})`);
      assert(allMatching[0].confidence === "0.400", "idempotent reuse: the EXISTING row's own confidence is UNCHANGED (not overwritten with the AI's confidence)");
      assert(allMatching[0].createdBy === "human", "idempotent reuse: the EXISTING row's own created_by is UNCHANGED");

      const postAuditCount = await countAuditEntries("claim_relationship", existing.id);
      assert(postAuditCount === preAuditCount, `idempotent reuse: ZERO new create/claim_relationship audit entries were written for the reused relationship (before: ${preAuditCount}, after: ${postAuditCount})`);

      const reviewAuditCount = await countAuditEntries("claim_comparison_review", review.id);
      assert(reviewAuditCount === 1, "idempotent reuse: exactly ONE claim_comparison_review audit entry IS written, even though no relationship was created");
    }

    // --- audit honesty: a genuinely NEW relationship DOES get one audit entry ---
    {
      const focus = await createTestClaim("Audit-honesty-new fixture focus claim.");
      const other = await createTestClaim("Audit-honesty-new fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "contradicts", confidence: 0.6, reasoning: "fixture" }]);

      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      assert(review.relationshipWasNewlyCreated === true, "audit honesty (new): relationship_was_newly_created is true");

      const auditCount = await countAuditEntries("claim_relationship", review.materializedRelationshipId!);
      assert(auditCount === 1, `audit honesty (new): exactly ONE create/claim_relationship audit entry IS written for a genuinely new relationship (got ${auditCount})`);
    }

    // --- rejection: decision + bridge, zero relationships, all-NULL snapshot ---
    {
      const focus = await createTestClaim("Rejection fixture focus claim.");
      const other = await createTestClaim("Rejection fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.4, reasoning: "fixture" }]);

      const preRelationshipTotal = (await db.select({ id: claimRelationships.id }).from(claimRelationships)).length;
      const { review } = await rejectClaimComparison({ aiResultId, assessmentIndex: 0, notes: "fixture rejection" });
      const postRelationshipTotal = (await db.select({ id: claimRelationships.id }).from(claimRelationships)).length;

      assert(postRelationshipTotal === preRelationshipTotal, "rejection: zero new claim_relationships rows across the whole table");
      assert(
        review.approvedClaimIdA === null &&
          review.approvedClaimIdB === null &&
          review.approvedRelationshipType === null &&
          review.materializedRelationshipId === null &&
          review.relationshipWasNewlyCreated === null,
        "rejection: all five snapshot columns are NULL"
      );

      const decision = await loadDecision(review.adminDecisionId);
      assert(decision.action === "reject", "rejection: the admin_decisions row's action is 'reject'");
    }

    // --- no ledger writes across ANY path above -----------------------------
    {
      const ledgerCountsAfterAll = await countLedgerRows();
      assert(
        ledgerCountsAfterAll.investigation === ledgerCountsBeforeAll.investigation,
        `no path so far wrote to claim_investigation_status_history (before: ${ledgerCountsBeforeAll.investigation}, after: ${ledgerCountsAfterAll.investigation})`
      );
      assert(
        ledgerCountsAfterAll.development === ledgerCountsBeforeAll.development,
        `no path so far wrote to claim_development_outcome_history (before: ${ledgerCountsBeforeAll.development}, after: ${ledgerCountsAfterAll.development})`
      );
    }

    // --- tamper barrier: submitted otherClaimId doesn't match persisted assessment ---
    {
      const focus = await createTestClaim("Tamper-barrier fixture focus claim.");
      const genuineOther = await createTestClaim("Tamper-barrier fixture genuine other claim.");
      const impostor = await createTestClaim("Tamper-barrier fixture impostor claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: genuineOther, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);

      try {
        await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: impostor, reason: "fixture" });
        assert(false, "tamper barrier: should have thrown");
      } catch (err) {
        assert(err instanceof OtherClaimNotAPersistedAssessmentError, "tamper barrier: a mismatched otherClaimId throws OtherClaimNotAPersistedAssessmentError");
      }

      const review = await loadReview(aiResultId, 0);
      assert(review === undefined, "tamper barrier: no review row was created for the rejected tamper attempt");
    }

    // --- approve-with-changes: action='edit', materializes the ADMIN's choice ---
    {
      const focus = await createTestClaim("Approve-with-changes fixture focus claim.");
      const other = await createTestClaim("Approve-with-changes fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [
        { otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "AI thought these were merely related." },
      ]);

      const { review } = await approveClaimComparisonWithChanges({
        aiResultId,
        assessmentIndex: 0,
        otherClaimId: other,
        relationshipType: "refines",
        direction: "focus_to_other",
        reason: "Admin judged this is actually a refines relationship.",
      });

      const relationship = await loadRelationship(review.materializedRelationshipId!);
      assert(relationship.relationshipType === "refines", "approve-with-changes: the materialized relationship uses the ADMIN's type ('refines'), NOT the AI's proposed type ('related')");
      assert(relationship.claimIdA === focus && relationship.claimIdB === other, "approve-with-changes: the admin's direction (focus_to_other) is honored in the stored orientation");

      const decision = await loadDecision(review.adminDecisionId);
      assert(decision.action === "edit", `approve-with-changes: the admin_decisions row's action is 'edit', NOT 'approve' (got '${decision.action}')`);
    }

    // --- double review is blocked; a losing concurrent approval's relationship insert rolls back ---
    {
      const focus = await createTestClaim("Double-review fixture focus claim.");
      const other = await createTestClaim("Double-review fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);

      const [first, second] = await Promise.allSettled([
        approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "attempt 1" }),
        approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "attempt 2" }),
      ]);

      const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
      const rejected = [first, second].filter((r) => r.status === "rejected");
      assert(fulfilled.length === 1, `double review: exactly one of two concurrent approvals succeeds (got ${fulfilled.length})`);
      assert(rejected.length === 1, `double review: exactly one of two concurrent approvals is rejected (got ${rejected.length})`);
      if (rejected[0] && rejected[0].status === "rejected") {
        assert(rejected[0].reason instanceof ComparisonAlreadyReviewedError, "double review: the losing attempt throws ComparisonAlreadyReviewedError");
      }

      const lowerId = Math.min(focus, other);
      const higherId = Math.max(focus, other);
      const relationshipsForPair = await db
        .select()
        .from(claimRelationships)
        .where(and(eq(claimRelationships.claimIdA, lowerId), eq(claimRelationships.claimIdB, higherId), eq(claimRelationships.relationshipType, "related")));
      assert(relationshipsForPair.length === 1, `double review: exactly ONE relationship row survives for this pair -- the loser's insert was rolled back with its whole transaction (got ${relationshipsForPair.length})`);
    }

    // --- append-only: UPDATE and DELETE on claim_comparison_reviews are both rejected ---
    {
      const focus = await createTestClaim("Append-only fixture focus claim.");
      const other = await createTestClaim("Append-only fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);
      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });

      let updateRejected = false;
      try {
        await db.execute(sql`UPDATE claim_comparison_reviews SET assessment_index = 999 WHERE id = ${review.id}`);
      } catch {
        updateRejected = true;
      }
      assert(updateRejected, "append-only: UPDATE on claim_comparison_reviews is rejected by the immutability trigger");

      let deleteRejected = false;
      try {
        await db.execute(sql`DELETE FROM claim_comparison_reviews WHERE id = ${review.id}`);
      } catch {
        deleteRejected = true;
      }
      assert(deleteRejected, "append-only: DELETE on claim_comparison_reviews is rejected by the immutability trigger");
    }

    // --- deletion survivability: approve, then delete the relationship -----
    {
      const focus = await createTestClaim("Deletion-survivability fixture focus claim.");
      const other = await createTestClaim("Deletion-survivability fixture other claim.");
      const aiResultId = await createCompareClaimsResult(focus, [{ otherClaimId: other, relationshipType: "related", confidence: 0.5, reasoning: "fixture" }]);
      const { review } = await approveClaimComparison({ aiResultId, assessmentIndex: 0, otherClaimId: other, reason: "fixture" });
      const relationshipId = review.materializedRelationshipId!;

      const deleted = await deleteClaimRelationship(relationshipId);
      assert(deleted !== undefined, "deletion survivability: deleteClaimRelationship SUCCEEDS -- no FK blocks it, no trigger fires");

      const reviewAfterDeletion = await loadReview(aiResultId, 0);
      assert(reviewAfterDeletion !== undefined, "deletion survivability: the bridge row is STILL PRESENT after the relationship is deleted");
      assert(reviewAfterDeletion.materializedRelationshipId === relationshipId, "deletion survivability: materialized_relationship_id still holds the (now-dangling) original id -- unchanged, per the immutability trigger");
      assert(
        reviewAfterDeletion.approvedClaimIdA !== null && reviewAfterDeletion.approvedRelationshipType !== null,
        "deletion survivability: the snapshot columns still fully describe the (now-deleted) relationship"
      );

      const dangling = await loadRelationship(relationshipId);
      assert(dangling === undefined, "deletion survivability: the relationship row itself is genuinely gone (confirms this is a real dangling reference, not a soft-delete)");
    }
  } finally {
    // Deliberately NO incremental row cleanup here -- same established
    // convention as claimProposalReview.check.ts/
    // detectDuplicatesOrchestration.check.ts: several cases above create
    // claim_comparison_reviews/admin_decisions rows that FK-reference the
    // ai_results/claims fixtures this file also creates, and
    // claim_comparison_reviews itself cannot be deleted at all (its own
    // immutability trigger, proven above). This check database is
    // expected to be recreated via a fresh migration chain + reseed for a
    // clean run (see README.md's verification sequence).
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll claim-comparison review checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
