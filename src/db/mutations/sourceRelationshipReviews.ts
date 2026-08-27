import "server-only";
import { and, eq } from "drizzle-orm";
import {
  adminDecisions,
  aiJobs,
  aiResults,
  sourceItems,
  sourceRelationships,
  sourceRelationshipReviews,
} from "@/db/schema";
import { isLatestSucceededProvenanceAnalysisResult, isSourceRelationshipReviewed, type PersistedProvenanceEdge } from "@/db/queries/admin";
import {
  approveSourceRelationshipReviewSchema,
  approveSourceRelationshipReviewWithChangesSchema,
  rejectSourceRelationshipReviewSchema,
} from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeProvenanceLink } from "@/lib/provenanceDirection";
import { logAdminAction, withAuditedTransaction, type DbExecutor, type DbTransaction } from "./shared";

/**
 * Phase 5 PR 8b. Structurally mirrors claimComparisonReviews.ts (PR7)
 * exactly, with two deliberate divergences documented in
 * docs/architecture.md and re-stated at each relevant point below:
 *
 *   1. SUPERSESSION IS ENFORCED HERE, SERVER-SIDE. PR7's compare_claims
 *      review mutations check only that the NAMED ai_result_id's own job
 *      succeeded -- not whether it is still the LATEST succeeded one for
 *      that focus claim (confirmed by direct inspection of
 *      claimComparisonReviews.ts; NOT changed by this PR, per explicit
 *      instruction: past behavior is not a defect this PR is scoped to
 *      fix). PR8b's own locked requirement is stricter: only
 *      recommendations belonging to the latest succeeded
 *      analyse_provenance result for the anchor claim are actionable, and
 *      this file enforces that with assertResultIsLatestSucceeded below,
 *      not merely by hiding the button in the UI.
 *   2. NO AI-AUTHORED CONFIDENCE/EVIDENCE ON THE DURABLE ROW. On approval,
 *      the resulting source_relationships row's confidence and
 *      evidence_note are ALWAYS NULL unless an admin explicitly supplies
 *      them elsewhere (they are not accepted as form input by this
 *      review flow at all) -- see insertSourceRelationshipTx below. This
 *      differs from PR7, where insertClaimRelationshipTx DOES accept and
 *      persist the (human-approved) confidence value onto
 *      claim_relationships.
 *
 * Directional identity: fromSourceItemId/toSourceItemId are ALWAYS the
 * effective subject/object -- source_item_id_a = subject = "from",
 * source_item_id_b = object = "to" (src/lib/provenanceDirection.ts).
 * Unlike compare_claims' focus/other + direction-field indirection, this
 * operation's schema already emits from/to directly in storage
 * orientation, so no resolveRawOrientation-style translation step exists
 * here -- the review's own fromSourceItemId/toSourceItemId ARE
 * sourceItemIdA/sourceItemIdB, subject to only the "with changes" swap
 * below.
 */

export class ProvenanceEdgeNotFoundError extends Error {
  constructor(aiResultId: number, edgeIndex: number) {
    super(
      `Edge ${edgeIndex} of analyse_provenance AI result #${aiResultId} could not be resolved -- ` +
        `cannot review an edge that does not exist or was not produced by a successful analysis.`
    );
    this.name = "ProvenanceEdgeNotFoundError";
  }
}

export class ProvenanceEdgeAlreadyReviewedError extends Error {
  constructor() {
    super("This provenance edge has already been reviewed.");
    this.name = "ProvenanceEdgeAlreadyReviewedError";
  }
}

export class ProvenancePairNotAPersistedEdgeError extends Error {
  constructor() {
    super(
      "The submitted source-item pair does not match this edge's own persisted analyse_provenance output -- " +
        "review must reference exactly the pair this edge's own successful analysis actually named."
    );
    this.name = "ProvenancePairNotAPersistedEdgeError";
  }
}

export class ProvenanceSourceItemNotFoundError extends Error {
  constructor(sourceItemId: number) {
    super(`Source item #${sourceItemId} could not be found -- cannot review a provenance relationship involving a source item that does not exist.`);
    this.name = "ProvenanceSourceItemNotFoundError";
  }
}

/**
 * PR8b-specific: thrown when the named ai_result_id is no longer the
 * latest succeeded analyse_provenance result for its anchor claim. A
 * newer succeeded analysis has since superseded it -- its unreviewed
 * edges remain preserved for audit but are no longer actionable.
 */
export class ProvenanceResultSupersededError extends Error {
  constructor() {
    super(
      "A newer analyse_provenance analysis has since completed for this claim -- this result is no longer the " +
        "latest succeeded analysis and its unreviewed edges can no longer be approved, edited, or rejected."
    );
    this.name = "ProvenanceResultSupersededError";
  }
}

export type ProvenanceEdgeContext = {
  aiResultId: number;
  edgeIndex: number;
  claimId: number;
  edge: PersistedProvenanceEdge;
};

/**
 * Re-reads and re-validates the persisted analyse_provenance result; no
 * relationshipType, basis, confidence, reasoning, or distinctEvidenceSummary
 * is ever accepted from an HTML form as authoritative -- only
 * fromSourceItemId/toSourceItemId are taken from the browser, and purely
 * as a lookup/tamper-check pair (see the callers below, which assert they
 * match what THIS function returns). Mirrors getComparisonAssessment's
 * shape exactly.
 */
export async function getProvenanceEdgeAssessment(db: DbExecutor, aiResultId: number, edgeIndex: number): Promise<ProvenanceEdgeContext | null> {
  const rows = await db
    .select({
      aiResultId: aiResults.id,
      structuredOutput: aiResults.structuredOutput,
      claimId: aiJobs.provenanceClaimId,
    })
    .from(aiResults)
    .innerJoin(aiJobs, eq(aiJobs.id, aiResults.aiJobId))
    .where(and(eq(aiResults.id, aiResultId), eq(aiJobs.operation, "analyse_provenance"), eq(aiJobs.status, "succeeded")))
    .limit(1);

  const row = rows[0];
  if (!row || row.claimId === null) return null;

  const structured = row.structuredOutput;
  if (!structured || typeof structured !== "object") return null;
  const edgesField = (structured as { edges?: unknown }).edges;
  if (!Array.isArray(edgesField)) return null;

  const raw = edgesField[edgeIndex];
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as { fromSourceItemId?: unknown }).fromSourceItemId !== "number" ||
    typeof (raw as { toSourceItemId?: unknown }).toSourceItemId !== "number" ||
    typeof (raw as { relationshipType?: unknown }).relationshipType !== "string" ||
    typeof (raw as { basis?: unknown }).basis !== "string" ||
    typeof (raw as { confidence?: unknown }).confidence !== "number" ||
    typeof (raw as { reasoning?: unknown }).reasoning !== "string"
  ) {
    return null;
  }

  const rawSummary = (raw as { distinctEvidenceSummary?: unknown }).distinctEvidenceSummary;

  return {
    aiResultId: row.aiResultId,
    edgeIndex,
    claimId: row.claimId,
    edge: {
      fromSourceItemId: (raw as { fromSourceItemId: number }).fromSourceItemId,
      toSourceItemId: (raw as { toSourceItemId: number }).toSourceItemId,
      relationshipType: (raw as { relationshipType: string }).relationshipType,
      basis: (raw as { basis: string }).basis,
      confidence: (raw as { confidence: number }).confidence,
      reasoning: (raw as { reasoning: string }).reasoning,
      distinctEvidenceSummary: typeof rawSummary === "string" ? rawSummary : null,
    },
  };
}

async function assertEdgeUnreviewed(db: DbExecutor, aiResultId: number, edgeIndex: number): Promise<void> {
  if (await isSourceRelationshipReviewed(db, aiResultId, edgeIndex)) {
    throw new ProvenanceEdgeAlreadyReviewedError();
  }
}

/**
 * PR8b's own server-side supersession gate -- re-checked from WITHIN the
 * caller's transaction (never trusted from a prior read), so a
 * concurrently-completing newer analysis cannot slip an approval through
 * between the initial page render and the form submit reaching this
 * mutation. The known sub-second READ COMMITTED race between this check
 * and a concurrent new analysis's own completion is accepted for PR8b, per
 * the locked plan -- this function does not hold a claim-row lock across
 * the provider call (there is no provider call in this file at all).
 */
async function assertResultIsLatestSucceeded(db: DbExecutor, claimId: number, aiResultId: number): Promise<void> {
  if (!(await isLatestSucceededProvenanceAnalysisResult(db, claimId, aiResultId))) {
    throw new ProvenanceResultSupersededError();
  }
}

async function loadAndValidateSourceItemPair(tx: DbExecutor, sourceItemIdA: number, sourceItemIdB: number): Promise<void> {
  const rows = await tx
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(eq(sourceItems.id, sourceItemIdA));
  if (rows.length === 0) throw new ProvenanceSourceItemNotFoundError(sourceItemIdA);

  const rowsB = await tx
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(eq(sourceItems.id, sourceItemIdB));
  if (rowsB.length === 0) throw new ProvenanceSourceItemNotFoundError(sourceItemIdB);
}

type SourceRelationshipRow = typeof sourceRelationships.$inferSelect;

/**
 * Insert-or-reuse for one EXACT directional (sourceItemIdA, sourceItemIdB,
 * relationshipType) triple -- deliberately NO canonicalization (mirrors
 * insertClaimRelationshipTx's shape, but provenance relationships are
 * directional by nature: (A,B) and (B,A) are different facts and both may
 * legitimately exist as separate rows, so unlike claim_relationships there
 * is no canonicalizeClaimRelationshipPair-equivalent step here at all).
 *
 * confidence and evidenceNote are ALWAYS persisted as NULL from this
 * review path -- see this file's header divergence note (2). Idempotent
 * reuse: reusing an already-existing exact row must never emit a fake
 * `create`/`source_relationship` audit entry -- see writeApproval below,
 * which only logs that entry when wasNewRelationship is true.
 */
async function insertSourceRelationshipTx(
  tx: DbTransaction,
  data: { sourceItemIdA: number; sourceItemIdB: number; relationshipType: string }
): Promise<{ relationship: SourceRelationshipRow; wasNewRelationship: boolean }> {
  const [inserted] = await tx
    .insert(sourceRelationships)
    .values({
      sourceItemIdA: data.sourceItemIdA,
      sourceItemIdB: data.sourceItemIdB,
      relationshipType: data.relationshipType as SourceRelationshipRow["relationshipType"],
      confidence: null,
      evidenceNote: null,
    })
    .onConflictDoNothing({
      target: [sourceRelationships.sourceItemIdA, sourceRelationships.sourceItemIdB, sourceRelationships.relationshipType],
    })
    .returning();

  if (inserted) return { relationship: inserted, wasNewRelationship: true };

  const [existing] = await tx
    .select()
    .from(sourceRelationships)
    .where(
      and(
        eq(sourceRelationships.sourceItemIdA, data.sourceItemIdA),
        eq(sourceRelationships.sourceItemIdB, data.sourceItemIdB),
        eq(sourceRelationships.relationshipType, data.relationshipType as SourceRelationshipRow["relationshipType"])
      )
    )
    .limit(1);

  // Under READ COMMITTED, a transaction that just observed ON CONFLICT DO
  // NOTHING skip a row must be able to see that same already-committed
  // conflicting row on an immediate re-select -- this branch should be
  // unreachable. Same defensive-invariant reasoning as
  // insertClaimRelationshipTx.
  if (!existing) {
    throw new Error(
      `insertSourceRelationshipTx invariant violation: ON CONFLICT DO NOTHING reported an existing row for ` +
        `(sourceItemIdA=${data.sourceItemIdA}, sourceItemIdB=${data.sourceItemIdB}, relationshipType=${data.relationshipType}), ` +
        `but no row was found on immediate re-select.`
    );
  }

  return { relationship: existing, wasNewRelationship: false };
}

type ReviewWriteResult = { review: typeof sourceRelationshipReviews.$inferSelect };

async function writeApproval(params: {
  tx: DbTransaction;
  admin: Awaited<ReturnType<typeof requireAdmin>>;
  aiResultId: number;
  edgeIndex: number;
  sourceItemIdA: number;
  sourceItemIdB: number;
  relationshipType: string;
  decisionAction: "approve" | "edit";
  reason: string | null;
  aiProposedMetadata?: Record<string, unknown>;
}): Promise<ReviewWriteResult> {
  const { tx, admin, aiResultId, edgeIndex, sourceItemIdA, sourceItemIdB, relationshipType, decisionAction, reason, aiProposedMetadata } = params;

  await loadAndValidateSourceItemPair(tx, sourceItemIdA, sourceItemIdB);

  const { relationship, wasNewRelationship } = await insertSourceRelationshipTx(tx, {
    sourceItemIdA,
    sourceItemIdB,
    relationshipType,
  });

  const [decision] = await tx
    .insert(adminDecisions)
    .values({ aiResultId, adminUserId: admin.id, action: decisionAction, notes: reason })
    .returning();

  const [review] = await tx
    .insert(sourceRelationshipReviews)
    .values({
      aiResultId,
      edgeIndex,
      adminDecisionId: decision.id,
      approvedSourceItemIdA: relationship.sourceItemIdA,
      approvedSourceItemIdB: relationship.sourceItemIdB,
      approvedRelationshipType: relationship.relationshipType,
      materializedRelationshipId: relationship.id,
      relationshipWasNewlyCreated: wasNewRelationship,
    })
    .returning();

  const summary = describeProvenanceLink(relationship.relationshipType, `Source item #${relationship.sourceItemIdA}`, `source item #${relationship.sourceItemIdB}`);

  if (wasNewRelationship) {
    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "source_relationship",
      entityId: relationship.id,
      summary: `Approved provenance edge ${edgeIndex} from AI result #${aiResultId} as source relationship #${relationship.id} (${summary})`,
      metadata: { aiResultId, edgeIndex, relationshipId: relationship.id },
    });
  }

  await logAdminAction(tx, admin, {
    action: "create",
    entityType: "source_relationship_review",
    entityId: review.id,
    summary: wasNewRelationship
      ? `Approved provenance edge ${edgeIndex} from AI result #${aiResultId} as source relationship #${relationship.id} (${summary})`
      : `Approved provenance edge ${edgeIndex} from AI result #${aiResultId}; source relationship #${relationship.id} (${summary}) already existed -- no new relationship created`,
    metadata: {
      aiResultId,
      edgeIndex,
      materializedRelationshipId: relationship.id,
      relationshipWasNewlyCreated: wasNewRelationship,
      effectiveSourceItemIdA: relationship.sourceItemIdA,
      effectiveSourceItemIdB: relationship.sourceItemIdB,
      effectiveRelationshipType: relationship.relationshipType,
      ...(aiProposedMetadata ?? {}),
    },
  });

  return { review };
}

/**
 * Approves one persisted analyse_provenance edge EXACTLY as the AI
 * proposed it -- relationshipType comes from the persisted edge, never
 * from the form. fromSourceItemId/toSourceItemId are taken from the
 * browser only as a tamper-check lookup pair.
 */
export async function approveSourceRelationshipReview(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = approveSourceRelationshipReviewSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getProvenanceEdgeAssessment(tx, data.aiResultId, data.edgeIndex);
    if (!context) throw new ProvenanceEdgeNotFoundError(data.aiResultId, data.edgeIndex);

    await assertResultIsLatestSucceeded(tx, context.claimId, context.aiResultId);
    await assertEdgeUnreviewed(tx, context.aiResultId, context.edgeIndex);

    if (data.fromSourceItemId !== context.edge.fromSourceItemId || data.toSourceItemId !== context.edge.toSourceItemId) {
      throw new ProvenancePairNotAPersistedEdgeError();
    }

    return writeApproval({
      tx,
      admin,
      aiResultId: context.aiResultId,
      edgeIndex: context.edgeIndex,
      sourceItemIdA: context.edge.fromSourceItemId,
      sourceItemIdB: context.edge.toSourceItemId,
      relationshipType: context.edge.relationshipType,
      decisionAction: "approve",
      reason: data.reason ?? null,
    });
  });
}

/**
 * Approves one persisted analyse_provenance edge with an admin override
 * of relationshipType and/or a swapped direction. fromSourceItemId/
 * toSourceItemId remain pure tamper-check lookup keys identifying WHICH
 * proposed edge is being reviewed -- swapDirection may swap which of
 * THESE SAME TWO items is the subject vs the object, but the admin can
 * never substitute a different pair of source items entirely (the
 * tamper-check above still runs against the persisted edge's own pair
 * before any swap is applied).
 */
export async function approveSourceRelationshipReviewWithChanges(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = approveSourceRelationshipReviewWithChangesSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getProvenanceEdgeAssessment(tx, data.aiResultId, data.edgeIndex);
    if (!context) throw new ProvenanceEdgeNotFoundError(data.aiResultId, data.edgeIndex);

    await assertResultIsLatestSucceeded(tx, context.claimId, context.aiResultId);
    await assertEdgeUnreviewed(tx, context.aiResultId, context.edgeIndex);

    if (data.fromSourceItemId !== context.edge.fromSourceItemId || data.toSourceItemId !== context.edge.toSourceItemId) {
      throw new ProvenancePairNotAPersistedEdgeError();
    }

    const [sourceItemIdA, sourceItemIdB] = data.swapDirection
      ? [context.edge.toSourceItemId, context.edge.fromSourceItemId]
      : [context.edge.fromSourceItemId, context.edge.toSourceItemId];

    return writeApproval({
      tx,
      admin,
      aiResultId: context.aiResultId,
      edgeIndex: context.edgeIndex,
      sourceItemIdA,
      sourceItemIdB,
      relationshipType: data.relationshipType,
      decisionAction: "edit",
      reason: data.reason ?? null,
      aiProposedMetadata: {
        aiProposedRelationshipType: context.edge.relationshipType,
        aiProposedFromSourceItemId: context.edge.fromSourceItemId,
        aiProposedToSourceItemId: context.edge.toSourceItemId,
        swappedDirection: data.swapDirection,
      },
    });
  });
}

/** Rejection remains auditable but creates no source_relationships row and no snapshot. */
export async function rejectSourceRelationshipReview(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = rejectSourceRelationshipReviewSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getProvenanceEdgeAssessment(tx, data.aiResultId, data.edgeIndex);
    if (!context) throw new ProvenanceEdgeNotFoundError(data.aiResultId, data.edgeIndex);

    await assertResultIsLatestSucceeded(tx, context.claimId, context.aiResultId);
    await assertEdgeUnreviewed(tx, context.aiResultId, context.edgeIndex);

    const [decision] = await tx
      .insert(adminDecisions)
      .values({ aiResultId: context.aiResultId, adminUserId: admin.id, action: "reject", notes: data.notes ?? null })
      .returning();

    const [review] = await tx
      .insert(sourceRelationshipReviews)
      .values({
        aiResultId: context.aiResultId,
        edgeIndex: context.edgeIndex,
        adminDecisionId: decision.id,
        // All four snapshot columns NULL -- a rejection materializes no
        // relationship, per source_relationship_reviews_approval_snapshot_complete.
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "source_relationship_review",
      entityId: review.id,
      summary: `Rejected provenance edge ${context.edgeIndex} from AI result #${context.aiResultId}`,
      metadata: {
        aiResultId: context.aiResultId,
        edgeIndex: context.edgeIndex,
        aiProposedRelationshipType: context.edge.relationshipType,
        aiProposedFromSourceItemId: context.edge.fromSourceItemId,
        aiProposedToSourceItemId: context.edge.toSourceItemId,
      },
    });

    return { review };
  });
}
