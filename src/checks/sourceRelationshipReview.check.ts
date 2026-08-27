/**
 * Phase 5 PR 8b regression check: the human review of one
 * analyse_provenance result's proposed edges -- the core of this PR.
 * Exercises the real, guarded approve/approve-with-changes/reject
 * mutations (src/db/mutations/sourceRelationshipReviews.ts) against a
 * local Postgres database. No AI provider call happens anywhere in this
 * file.
 *
 * Proves:
 *   - approving an edge exactly as proposed persists the EXACT directed
 *     (source_item_id_a, source_item_id_b, relationship_type) triple,
 *     with confidence AND evidence_note BOTH NULL on the durable row --
 *     the PR8b durable-row NULL policy divergence from PR7 (see
 *     docs/architecture.md)
 *   - approve-with-changes records action='edit' and materializes the
 *     ADMIN's relationship type; swapDirection swaps which of the SAME
 *     TWO items is stored as the subject vs the object
 *   - rejection creates a decision + bridge row but ZERO
 *     source_relationships rows and an all-NULL snapshot
 *   - the fromSourceItemId/toSourceItemId tamper barrier rejects a
 *     submitted pair that doesn't match this edge's own persisted output
 *   - a double review of the same edge is blocked
 *     (ProvenanceEdgeAlreadyReviewedError)
 *   - SUPERSESSION IS ENFORCED SERVER-SIDE (the PR8b-specific
 *     requirement, NOT present in PR7's compare_claims review mutations):
 *     once a NEWER succeeded analyse_provenance result exists for the
 *     same anchor claim, approving/editing/rejecting an edge from the
 *     OLDER result throws ProvenanceResultSupersededError -- verified
 *     for all three mutations
 *   - IDEMPOTENT REUSE: approving two DIFFERENT persisted edges (from two
 *     different ai_results, even) that resolve to the exact same
 *     directed (a, b, type) triple reuses the SAME source_relationships
 *     row -- no duplicate row, and the second approval's audit entry
 *     correctly reports "already existed", not a fake
 *     create/source_relationship entry
 *   - DIRECTIONAL COEXISTENCE: approving edge (A -> B, citation) and
 *     separately approving edge (B -> A, citation) -- the reverse
 *     direction of the SAME pair -- persists TWO DISTINCT
 *     source_relationships rows, proving (A,B) and (B,A) are never
 *     canonicalized together the way claim_relationships' symmetric
 *     types are
 *   - source_relationship_reviews is append-only: UPDATE and DELETE are
 *     both rejected by its trigger
 *
 * Run with: npx tsx --conditions=react-server src/checks/sourceRelationshipReview.check.ts
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
  sources,
  sourceItems,
  sourceTypes,
  sourceItemTypes,
  sourceRelationships,
  sourceRelationshipReviews,
  adminDecisions,
  adminAuditLog,
} from "../db/schema";
import {
  approveSourceRelationshipReview,
  approveSourceRelationshipReviewWithChanges,
  rejectSourceRelationshipReview,
  ProvenanceEdgeAlreadyReviewedError,
  ProvenancePairNotAPersistedEdgeError,
  ProvenanceResultSupersededError,
} from "../db/mutations/sourceRelationshipReviews";

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
    const [row] = await db.insert(claims).values({ projectId: SEEDED_PROJECT_ID, slug: `pr8b-review-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return row.id;
  }

  const [aSourceType] = await db.select().from(sourceTypes).limit(1);
  const [aSourceItemType] = await db.select().from(sourceItemTypes).limit(1);
  if (!aSourceType || !aSourceItemType) throw new Error("Seed data missing: expected at least one source_types/source_item_types row. Run npm run db:seed first.");

  async function createTestSourceItem(): Promise<number> {
    const [src] = await db.insert(sources).values({ name: `PR8b review fixture source ${randomUUID()}`, sourceTypeId: aSourceType.id }).returning();
    const [item] = await db
      .insert(sourceItems)
      .values({ sourceId: src.id, itemTypeId: aSourceItemType.id, url: `https://example.test/review-${randomUUID()}` })
      .returning();
    return item.id;
  }

  /** One genuine succeeded analyse_provenance ai_job + ai_result, with a real structured_output containing the given edges at their array index. completedAt is settable so supersession ordering can be controlled precisely. */
  async function createProvenanceResult(claimId: number, edges: unknown[], completedAt: Date = new Date()): Promise<number> {
    const [job] = await db
      .insert(aiJobs)
      .values({ operation: "analyse_provenance", provider: "fake", model: "test-model", status: "succeeded", provenanceClaimId: claimId, completedAt })
      .returning();
    const [result] = await db.insert(aiResults).values({ aiJobId: job.id, structuredOutput: { edges } }).returning();
    return result.id;
  }

  async function loadRelationship(id: number) {
    const [row] = await db.select().from(sourceRelationships).where(eq(sourceRelationships.id, id));
    return row;
  }

  async function findRelationship(a: number, b: number, type: string) {
    const [row] = await db
      .select()
      .from(sourceRelationships)
      .where(and(eq(sourceRelationships.sourceItemIdA, a), eq(sourceRelationships.sourceItemIdB, b), eq(sourceRelationships.relationshipType, type as never)));
    return row ?? null;
  }

  async function loadReview(aiResultId: number, edgeIndex: number) {
    const [row] = await db
      .select()
      .from(sourceRelationshipReviews)
      .where(and(eq(sourceRelationshipReviews.aiResultId, aiResultId), eq(sourceRelationshipReviews.edgeIndex, edgeIndex)));
    return row;
  }

  async function loadDecision(id: number) {
    const [row] = await db.select().from(adminDecisions).where(eq(adminDecisions.id, id));
    return row;
  }

  async function countAuditEntries(entityType: "source_relationship" | "source_relationship_review", entityId: number): Promise<number> {
    const rows = await db.select({ id: adminAuditLog.id }).from(adminAuditLog).where(and(eq(adminAuditLog.entityType, entityType), eq(adminAuditLog.entityId, entityId)));
    return rows.length;
  }

  try {
    console.log("=== analyse_provenance human review (Phase 5 PR 8b) -- DB only, no AI calls ===\n");

    // --- approve exactly as proposed: correct triple, NULL confidence/evidence_note ---
    {
      const claimId = await createTestClaim("Approve-as-proposed fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = {
        fromSourceItemId: itemA,
        toSourceItemId: itemB,
        relationshipType: "citation",
        basis: "Direct link.",
        confidence: 0.87,
        reasoning: "Explicit citation observed.",
      };
      const aiResultId = await createProvenanceResult(claimId, [edge]);

      const outcome = await approveSourceRelationshipReview({ aiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });
      const review = outcome.review;
      assert(review.approvedSourceItemIdA === itemA && review.approvedSourceItemIdB === itemB, "approve-as-proposed: snapshot records the exact directed pair");
      assert(review.approvedRelationshipType === "citation", "approve-as-proposed: snapshot records the AI's relationship type");
      assert(review.relationshipWasNewlyCreated === true, "approve-as-proposed: relationship was newly created");

      const relationship = await loadRelationship(review.materializedRelationshipId!);
      assert(relationship.sourceItemIdA === itemA && relationship.sourceItemIdB === itemB, "approve-as-proposed: durable row stores A=subject/B=object exactly");
      assert(relationship.confidence === null, "DURABLE ROW NULL POLICY: source_relationships.confidence is NULL despite the AI's own confidence (0.87) -- never copied onto the durable row");
      assert(relationship.evidenceNote === null, "DURABLE ROW NULL POLICY: source_relationships.evidence_note is NULL -- never populated from AI reasoning/basis");

      const decision = await loadDecision(review.adminDecisionId);
      assert(decision.action === "approve", "approve-as-proposed: admin_decisions.action is 'approve'");

      assert((await countAuditEntries("source_relationship", review.materializedRelationshipId!)) === 1, "approve-as-proposed: exactly one create/source_relationship audit entry");
      assert((await countAuditEntries("source_relationship_review", review.id)) === 1, "approve-as-proposed: exactly one create/source_relationship_review audit entry");
    }

    // --- reject: zero source_relationships rows, all-NULL snapshot --------
    {
      const claimId = await createTestClaim("Reject fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "repetition", basis: "b", confidence: 0.5, reasoning: "r" };
      const aiResultId = await createProvenanceResult(claimId, [edge]);

      const relationshipCountBefore = (await db.select({ id: sourceRelationships.id }).from(sourceRelationships)).length;
      const outcome = await rejectSourceRelationshipReview({ aiResultId, edgeIndex: 0, notes: "Not a real relationship." });
      const relationshipCountAfter = (await db.select({ id: sourceRelationships.id }).from(sourceRelationships)).length;

      assert(relationshipCountAfter === relationshipCountBefore, "reject: zero source_relationships rows created");
      assert(
        outcome.review.approvedSourceItemIdA === null &&
          outcome.review.approvedSourceItemIdB === null &&
          outcome.review.approvedRelationshipType === null &&
          outcome.review.materializedRelationshipId === null &&
          outcome.review.relationshipWasNewlyCreated === null,
        "reject: the snapshot is entirely NULL"
      );
    }

    // --- tamper barrier: submitted pair must match the persisted edge -----
    {
      const claimId = await createTestClaim("Tamper fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const itemC = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "derivative", basis: "b", confidence: 0.6, reasoning: "r" };
      const aiResultId = await createProvenanceResult(claimId, [edge]);

      let threw = false;
      try {
        await approveSourceRelationshipReview({ aiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemC });
      } catch (err) {
        threw = err instanceof ProvenancePairNotAPersistedEdgeError;
      }
      assert(threw, "tamper barrier: a submitted toSourceItemId that doesn't match the persisted edge is rejected");
    }

    // --- double review blocked ----------------------------------------------
    {
      const claimId = await createTestClaim("Double-review fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "aggregation", basis: "b", confidence: 0.6, reasoning: "r" };
      const aiResultId = await createProvenanceResult(claimId, [edge]);

      await approveSourceRelationshipReview({ aiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });

      let threw = false;
      try {
        await rejectSourceRelationshipReview({ aiResultId, edgeIndex: 0 });
      } catch (err) {
        threw = err instanceof ProvenanceEdgeAlreadyReviewedError;
      }
      assert(threw, "double review: a second review attempt on the same (aiResultId, edgeIndex) is blocked");
    }

    // --- approve-with-changes: type override + swapDirection ---------------
    {
      const claimId = await createTestClaim("Approve-with-changes fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "unknown", basis: "b", confidence: 0.4, reasoning: "r" };
      const aiResultId = await createProvenanceResult(claimId, [edge]);

      const outcome = await approveSourceRelationshipReviewWithChanges({
        aiResultId,
        edgeIndex: 0,
        fromSourceItemId: itemA,
        toSourceItemId: itemB,
        relationshipType: "citation",
        swapDirection: true,
      });

      const decision = await loadDecision(outcome.review.adminDecisionId);
      assert(decision.action === "edit", "approve-with-changes: admin_decisions.action is 'edit'");
      assert(outcome.review.approvedRelationshipType === "citation", "approve-with-changes: materializes the ADMIN's relationship type, not the AI's ('unknown')");
      assert(
        outcome.review.approvedSourceItemIdA === itemB && outcome.review.approvedSourceItemIdB === itemA,
        "approve-with-changes: swapDirection swaps which of the SAME TWO items is subject vs object"
      );
    }

    // --- SUPERSESSION enforced server-side (PR8b-specific requirement) -----
    {
      const claimId = await createTestClaim("Supersession fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const olderEdge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "older" };
      const newerEdge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "repetition", basis: "b", confidence: 0.5, reasoning: "newer" };

      const olderAiResultId = await createProvenanceResult(claimId, [olderEdge], new Date(Date.now() - 60_000));
      const newerAiResultId = await createProvenanceResult(claimId, [newerEdge], new Date());

      let approveThrew = false;
      try {
        await approveSourceRelationshipReview({ aiResultId: olderAiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });
      } catch (err) {
        approveThrew = err instanceof ProvenanceResultSupersededError;
      }
      assert(approveThrew, "supersession: approving an edge from a SUPERSEDED (non-latest) result throws ProvenanceResultSupersededError");

      let editThrew = false;
      try {
        await approveSourceRelationshipReviewWithChanges({
          aiResultId: olderAiResultId,
          edgeIndex: 0,
          fromSourceItemId: itemA,
          toSourceItemId: itemB,
          relationshipType: "unknown",
          swapDirection: false,
        });
      } catch (err) {
        editThrew = err instanceof ProvenanceResultSupersededError;
      }
      assert(editThrew, "supersession: editing an edge from a SUPERSEDED result throws ProvenanceResultSupersededError");

      let rejectThrew = false;
      try {
        await rejectSourceRelationshipReview({ aiResultId: olderAiResultId, edgeIndex: 0 });
      } catch (err) {
        rejectThrew = err instanceof ProvenanceResultSupersededError;
      }
      assert(rejectThrew, "supersession: rejecting an edge from a SUPERSEDED result throws ProvenanceResultSupersededError");

      // The LATEST result's own edge must remain fully actionable.
      const latestOutcome = await approveSourceRelationshipReview({ aiResultId: newerAiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });
      assert(latestOutcome.review.approvedRelationshipType === "repetition", "supersession: the LATEST succeeded result's own edge is still approvable");
    }

    // --- IDEMPOTENT REUSE across two different ai_results -------------------
    {
      const claimId = await createTestClaim("Idempotent-reuse fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r" };

      // Two independent succeeded results, each proposing the SAME exact
      // directed triple -- approving both must reuse one row.
      const firstAiResultId = await createProvenanceResult(claimId, [edge], new Date(Date.now() - 120_000));
      const firstOutcome = await approveSourceRelationshipReview({ aiResultId: firstAiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });
      assert(firstOutcome.review.relationshipWasNewlyCreated === true, "idempotent reuse: the FIRST approval creates a new relationship");

      const secondAiResultId = await createProvenanceResult(claimId, [edge], new Date());
      const secondOutcome = await approveSourceRelationshipReview({ aiResultId: secondAiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });
      assert(secondOutcome.review.relationshipWasNewlyCreated === false, "idempotent reuse: the SECOND approval of the SAME triple reuses the existing relationship");
      assert(
        secondOutcome.review.materializedRelationshipId === firstOutcome.review.materializedRelationshipId,
        "idempotent reuse: both reviews reference the SAME materialized_relationship_id -- no duplicate row"
      );

      const relCount = (await db
        .select({ id: sourceRelationships.id })
        .from(sourceRelationships)
        .where(and(eq(sourceRelationships.sourceItemIdA, itemA), eq(sourceRelationships.sourceItemIdB, itemB), eq(sourceRelationships.relationshipType, "citation")))
      ).length;
      assert(relCount === 1, `idempotent reuse: exactly one source_relationships row exists for this exact triple (got ${relCount})`);

      // No fake create/source_relationship audit entry on the second (reused) approval.
      assert(
        (await countAuditEntries("source_relationship", firstOutcome.review.materializedRelationshipId!)) === 1,
        "idempotent reuse: exactly ONE create/source_relationship audit entry total -- the reused approval does not emit a second fake one"
      );
      assert(
        (await countAuditEntries("source_relationship_review", secondOutcome.review.id)) === 1,
        "idempotent reuse: the second (reused) approval still gets its OWN create/source_relationship_review audit entry"
      );
    }

    // --- DIRECTIONAL COEXISTENCE: (A,B) and (B,A) both persist --------------
    {
      const claimId = await createTestClaim("Directional-coexistence fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();

      const forwardAiResultId = await createProvenanceResult(
        claimId,
        [{ fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "citation", basis: "A cites B.", confidence: 0.8, reasoning: "r1" }],
        new Date(Date.now() - 120_000)
      );
      const forwardOutcome = await approveSourceRelationshipReview({ aiResultId: forwardAiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });

      const reverseAiResultId = await createProvenanceResult(
        claimId,
        [{ fromSourceItemId: itemB, toSourceItemId: itemA, relationshipType: "citation", basis: "B ALSO cites A independently.", confidence: 0.7, reasoning: "r2" }],
        new Date()
      );
      const reverseOutcome = await approveSourceRelationshipReview({ aiResultId: reverseAiResultId, edgeIndex: 0, fromSourceItemId: itemB, toSourceItemId: itemA });

      assert(forwardOutcome.review.relationshipWasNewlyCreated === true, "directional coexistence: the forward (A,B) edge is newly created");
      assert(reverseOutcome.review.relationshipWasNewlyCreated === true, "directional coexistence: the reverse (B,A) edge is ALSO newly created, NOT treated as a reuse of the forward row");
      assert(
        forwardOutcome.review.materializedRelationshipId !== reverseOutcome.review.materializedRelationshipId,
        "directional coexistence: (A,B) and (B,A) materialize as TWO DISTINCT source_relationships rows"
      );

      const forwardRow = await findRelationship(itemA, itemB, "citation");
      const reverseRow = await findRelationship(itemB, itemA, "citation");
      assert(forwardRow !== null && reverseRow !== null, "directional coexistence: BOTH the (A,B) and (B,A) rows are independently queryable and coexist in the database");
    }

    // --- append-only: UPDATE and DELETE both rejected -----------------------
    {
      const claimId = await createTestClaim("Immutability fixture claim.");
      const itemA = await createTestSourceItem();
      const itemB = await createTestSourceItem();
      const edge = { fromSourceItemId: itemA, toSourceItemId: itemB, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r" };
      const aiResultId = await createProvenanceResult(claimId, [edge]);
      const outcome = await approveSourceRelationshipReview({ aiResultId, edgeIndex: 0, fromSourceItemId: itemA, toSourceItemId: itemB });

      let updateRejected = false;
      try {
        await db.execute(sql`UPDATE source_relationship_reviews SET edge_index = 999 WHERE id = ${outcome.review.id}`);
      } catch {
        updateRejected = true;
      }
      assert(updateRejected, "append-only: UPDATE on source_relationship_reviews is rejected by its trigger");

      let deleteRejected = false;
      try {
        await db.execute(sql`DELETE FROM source_relationship_reviews WHERE id = ${outcome.review.id}`);
      } catch {
        deleteRejected = true;
      }
      assert(deleteRejected, "append-only: DELETE on source_relationship_reviews is rejected by its trigger");
    }
  } finally {
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll analyse_provenance review checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
