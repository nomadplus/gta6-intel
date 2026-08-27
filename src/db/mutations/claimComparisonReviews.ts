import "server-only";
import { DIRECTIONAL_RELATIONSHIP_TYPES, SYMMETRIC_RELATIONSHIP_TYPES } from "@/lib/relationshipCanonicalization";
import {
  adminDecisions,
  aiJobs,
  aiResults,
  claimComparisonReviews,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getClaimForComparison,
  isComparisonReviewed,
  type PersistedComparisonAssessment,
} from "@/db/queries/admin";
import { insertClaimRelationshipTx } from "./claimRelationships";
import {
  approveClaimComparisonSchema,
  approveClaimComparisonWithChangesSchema,
  rejectClaimComparisonSchema,
} from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { logAdminAction, withAuditedTransaction, type DbExecutor, type DbTransaction } from "./shared";

export class ComparisonAssessmentNotFoundError extends Error {
  constructor(aiResultId: number, assessmentIndex: number) {
    super(
      `Assessment ${assessmentIndex} of compare_claims AI result #${aiResultId} could not be resolved -- ` +
        `cannot review an assessment that does not exist or was not produced by a successful comparison.`
    );
    this.name = "ComparisonAssessmentNotFoundError";
  }
}

export class ComparisonAlreadyReviewedError extends Error {
  constructor() {
    super("This relationship assessment has already been reviewed.");
    this.name = "ComparisonAlreadyReviewedError";
  }
}

export class OtherClaimNotAPersistedAssessmentError extends Error {
  constructor() {
    super(
      "The submitted otherClaimId does not match this assessment's own persisted compare_claims output -- " +
        "review must reference exactly the claim this assessment's own successful analysis actually named."
    );
    this.name = "OtherClaimNotAPersistedAssessmentError";
  }
}

export class ComparisonClaimNotFoundError extends Error {
  constructor(claimId: number) {
    super(`Claim #${claimId} could not be found -- cannot review a relationship involving a claim that does not exist.`);
    this.name = "ComparisonClaimNotFoundError";
  }
}

export class ComparisonProjectMismatchError extends Error {
  constructor() {
    super("The focus claim and the other claim belong to different projects -- a relationship cannot be recorded between them.");
    this.name = "ComparisonProjectMismatchError";
  }
}

export type ComparisonAssessmentContext = {
  aiResultId: number;
  assessmentIndex: number;
  focusClaimId: number;
  assessment: PersistedComparisonAssessment;
};

/**
 * Re-reads and re-validates the persisted compare_claims result; no
 * relationshipType, direction, confidence, or reasoning is ever accepted
 * from an HTML form as authoritative -- only otherClaimId is taken from
 * the browser, and purely as a lookup/tamper-check key (see the callers
 * below, which assert it matches what THIS function returns).
 *
 * Deliberately NEUTRAL -- returns null rather than throwing when the
 * assessment cannot be resolved, mirroring getExtractionCandidate's
 * (claimProposalReviews.ts) shape exactly. Uses the SAME defensive
 * shape-check approach getLatestSuccessfulCompareClaimsResult
 * (src/db/queries/admin/index.ts) uses for display, rather than
 * reconstructing compare_claims' own Zod schema
 * (buildCompareClaimsOutputSchema) -- that schema is parameterized by
 * the exact focus claim + candidate-claim-id set a given call was
 * offered, an ephemeral input to that one call that is never persisted
 * in its own right, so there is nothing to reconstruct it from later.
 * This mirrors the identical reasoning
 * detectDuplicatesTrigger.ts/claimProposalReviews.ts already established
 * for detect_duplicates' own resolution flow (resolveProposalAsExistingClaim
 * uses getLatestDetectDuplicatesMatches, not a schema reconstruction,
 * for exactly this reason).
 *
 * Accepts a DbExecutor so it can run either as a standalone read (plain
 * adminDb) or as part of a larger atomic transaction (every mutation
 * below's own tx, re-verifying against transaction-consistent state
 * rather than a possibly-stale prior read).
 */
export async function getComparisonAssessment(
  db: DbExecutor,
  aiResultId: number,
  assessmentIndex: number
): Promise<ComparisonAssessmentContext | null> {
  const rows = await db
    .select({
      aiResultId: aiResults.id,
      structuredOutput: aiResults.structuredOutput,
      focusClaimId: aiJobs.comparisonClaimId,
    })
    .from(aiResults)
    .innerJoin(aiJobs, eq(aiJobs.id, aiResults.aiJobId))
    .where(and(eq(aiResults.id, aiResultId), eq(aiJobs.operation, "compare_claims"), eq(aiJobs.status, "succeeded")))
    .limit(1);

  const row = rows[0];
  if (!row || row.focusClaimId === null) return null;

  const structured = row.structuredOutput;
  if (!structured || typeof structured !== "object") return null;
  const assessmentsField = (structured as { assessments?: unknown }).assessments;
  if (!Array.isArray(assessmentsField)) return null;

  const raw = assessmentsField[assessmentIndex];
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as { otherClaimId?: unknown }).otherClaimId !== "number" ||
    typeof (raw as { relationshipType?: unknown }).relationshipType !== "string" ||
    typeof (raw as { confidence?: unknown }).confidence !== "number" ||
    typeof (raw as { reasoning?: unknown }).reasoning !== "string"
  ) {
    return null;
  }

  const rawDirection = (raw as { direction?: unknown }).direction;
  const direction = rawDirection === "focus_to_other" || rawDirection === "other_to_focus" ? rawDirection : null;

  return {
    aiResultId: row.aiResultId,
    assessmentIndex,
    focusClaimId: row.focusClaimId,
    assessment: {
      otherClaimId: (raw as { otherClaimId: number }).otherClaimId,
      relationshipType: (raw as { relationshipType: string }).relationshipType,
      direction,
      confidence: (raw as { confidence: number }).confidence,
      reasoning: (raw as { reasoning: string }).reasoning,
    },
  };
}

async function assertComparisonUnreviewed(db: DbExecutor, aiResultId: number, assessmentIndex: number): Promise<void> {
  if (await isComparisonReviewed(db, aiResultId, assessmentIndex)) {
    throw new ComparisonAlreadyReviewedError();
  }
}

/**
 * Resolves the raw (claimIdA, claimIdB) orientation for insertion from
 * the focus claim, the other claim, and a direction. Symmetric types
 * (equivalent/related/contradicts) have no direction -- this always
 * yields [focusClaimId, otherClaimId] for them, but that raw orientation
 * is irrelevant: insertClaimRelationshipTx canonicalizes it before
 * storing. Directional types use direction to decide which claim is
 * the "from" side; direction is REQUIRED for these (enforced by the
 * calling schema and re-asserted below) since there is no sensible
 * default orientation for "subsumes"/"refines".
 */
function resolveRawOrientation(
  focusClaimId: number,
  otherClaimId: number,
  relationshipType: string,
  direction: "focus_to_other" | "other_to_focus" | null
): [number, number] {
  if (DIRECTIONAL_RELATIONSHIP_TYPES.has(relationshipType)) {
    if (direction === null) {
      throw new Error(
        `resolveRawOrientation invariant violation: relationshipType '${relationshipType}' is directional but no direction was supplied.`
      );
    }
    return direction === "other_to_focus" ? [otherClaimId, focusClaimId] : [focusClaimId, otherClaimId];
  }
  return [focusClaimId, otherClaimId];
}

interface ClaimSnapshot {
  id: number;
  projectId: number;
}

/** Loads and validates both sides of a comparison from WITHIN the caller's transaction -- never trusted from a prior read. */
async function loadAndValidateClaimPair(
  tx: DbExecutor,
  focusClaimId: number,
  otherClaimId: number
): Promise<{ focusClaim: ClaimSnapshot; otherClaim: ClaimSnapshot }> {
  const focusClaim = await getClaimForComparison(tx, focusClaimId);
  if (!focusClaim) throw new ComparisonClaimNotFoundError(focusClaimId);
  const otherClaim = await getClaimForComparison(tx, otherClaimId);
  if (!otherClaim) throw new ComparisonClaimNotFoundError(otherClaimId);
  if (focusClaim.projectId !== otherClaim.projectId) throw new ComparisonProjectMismatchError();
  return { focusClaim, otherClaim };
}

type ReviewWriteResult = { review: typeof claimComparisonReviews.$inferSelect };

/**
 * Shared write tail for both approval paths (approve-as-proposed and
 * approve-with-changes): resolve orientation, insert-or-reuse the
 * relationship, insert the admin_decisions row with the given action,
 * insert the immutable claim_comparison_reviews snapshot -- populated
 * STRICTLY from the row insertClaimRelationshipTx actually returned,
 * never from the raw pre-canonicalization orientation -- and emit the
 * `create`/`claim_relationship` audit entry IF AND ONLY IF a new
 * relationship row was genuinely inserted. The
 * `create`/`claim_comparison_review` audit entry is ALWAYS emitted,
 * regardless of reuse.
 */
async function writeApproval(params: {
  tx: DbTransaction;
  admin: Awaited<ReturnType<typeof requireAdmin>>;
  aiResultId: number;
  assessmentIndex: number;
  focusClaimId: number;
  otherClaimId: number;
  relationshipType: string;
  direction: "focus_to_other" | "other_to_focus" | null;
  confidence: number | null;
  decisionAction: "approve" | "edit";
  reason: string | null;
  aiProposedMetadata?: Record<string, unknown>;
}): Promise<ReviewWriteResult> {
  const { tx, admin, aiResultId, assessmentIndex, focusClaimId, otherClaimId, relationshipType, direction, confidence, decisionAction, reason, aiProposedMetadata } =
    params;

  // Existence and same-project validation -- otherClaim itself is not
  // otherwise used; the check throwing is the point.
  await loadAndValidateClaimPair(tx, focusClaimId, otherClaimId);

  const [rawA, rawB] = resolveRawOrientation(focusClaimId, otherClaimId, relationshipType, direction);

  // insertClaimRelationshipTx applies canonicalizeClaimRelationshipPair()
  // internally -- the row it returns (relationship.claimIdA/claimIdB) is
  // the ACTUAL EFFECTIVE stored orientation, which is exactly what the
  // immutable snapshot below must record, never the raw rawA/rawB values.
  const { relationship, wasNewRelationship } = await insertClaimRelationshipTx(tx, {
    claimIdA: rawA,
    claimIdB: rawB,
    relationshipType: relationshipType as "equivalent" | "subsumes" | "refines" | "contradicts" | "related",
    confidence,
    // Locked decision: the effective graph mutation is authored by a
    // human, because it only ever takes effect after explicit human
    // approval -- the AI recommendation's own provenance is fully
    // preserved via ai_jobs -> ai_results -> admin_decisions ->
    // claim_comparison_reviews, not via this column.
    createdBy: "human",
  });

  const [decision] = await tx
    .insert(adminDecisions)
    .values({
      aiResultId,
      adminUserId: admin.id,
      action: decisionAction,
      notes: reason,
    })
    .returning();

  const [review] = await tx
    .insert(claimComparisonReviews)
    .values({
      aiResultId,
      assessmentIndex,
      adminDecisionId: decision.id,
      approvedClaimIdA: relationship.claimIdA,
      approvedClaimIdB: relationship.claimIdB,
      approvedRelationshipType: relationship.relationshipType,
      materializedRelationshipId: relationship.id,
      relationshipWasNewlyCreated: wasNewRelationship,
    })
    .returning();

  // The audit `create`/`claim_relationship` entry is emitted IF AND ONLY
  // IF insertClaimRelationshipTx genuinely inserted a new row -- an
  // already-existing relationship being reused must never be described
  // to an auditor as having just been created.
  if (wasNewRelationship) {
    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "claim_relationship",
      entityId: relationship.id,
      summary: `Approved comparison assessment ${assessmentIndex} from AI result #${aiResultId} as claim relationship #${relationship.id} (claim #${relationship.claimIdA} ${relationship.relationshipType} claim #${relationship.claimIdB})`,
      metadata: { aiResultId, assessmentIndex, relationshipId: relationship.id },
    });
  }

  await logAdminAction(tx, admin, {
    action: "create",
    entityType: "claim_comparison_review",
    entityId: review.id,
    summary: wasNewRelationship
      ? `Approved comparison assessment ${assessmentIndex} from AI result #${aiResultId} as claim relationship #${relationship.id} (claim #${relationship.claimIdA} ${relationship.relationshipType} claim #${relationship.claimIdB})`
      : `Approved comparison assessment ${assessmentIndex} from AI result #${aiResultId}; claim relationship #${relationship.id} (claim #${relationship.claimIdA} ${relationship.relationshipType} claim #${relationship.claimIdB}) already existed -- no new relationship created`,
    metadata: {
      aiResultId,
      assessmentIndex,
      materializedRelationshipId: relationship.id,
      relationshipWasNewlyCreated: wasNewRelationship,
      effectiveClaimIdA: relationship.claimIdA,
      effectiveClaimIdB: relationship.claimIdB,
      effectiveRelationshipType: relationship.relationshipType,
      ...(aiProposedMetadata ?? {}),
    },
  });

  return { review };
}

/**
 * Approves one persisted compare_claims assessment EXACTLY as the AI
 * proposed it -- relationshipType, direction, and confidence all come
 * from the persisted assessment, never from the form. Only otherClaimId
 * is taken from the browser, purely as a tamper-check lookup key.
 */
export async function approveClaimComparison(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = approveClaimComparisonSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getComparisonAssessment(tx, data.aiResultId, data.assessmentIndex);
    if (!context) throw new ComparisonAssessmentNotFoundError(data.aiResultId, data.assessmentIndex);

    await assertComparisonUnreviewed(tx, context.aiResultId, context.assessmentIndex);

    if (data.otherClaimId !== context.assessment.otherClaimId) {
      throw new OtherClaimNotAPersistedAssessmentError();
    }

    return writeApproval({
      tx,
      admin,
      aiResultId: context.aiResultId,
      assessmentIndex: context.assessmentIndex,
      focusClaimId: context.focusClaimId,
      otherClaimId: context.assessment.otherClaimId,
      relationshipType: context.assessment.relationshipType,
      direction: context.assessment.direction,
      confidence: context.assessment.confidence,
      decisionAction: "approve",
      reason: data.reason ?? null,
    });
  });
}

/**
 * Approves one persisted compare_claims assessment with an admin
 * override of relationshipType/direction. otherClaimId remains a pure
 * tamper-check lookup key -- the admin may override WHICH relationship
 * type applies, never WHICH claim it targets. Recorded with
 * admin_decisions.action = 'edit' rather than 'approve', so the audit
 * trail distinguishes "the AI was right" from "the AI was close."
 */
export async function approveClaimComparisonWithChanges(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = approveClaimComparisonWithChangesSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getComparisonAssessment(tx, data.aiResultId, data.assessmentIndex);
    if (!context) throw new ComparisonAssessmentNotFoundError(data.aiResultId, data.assessmentIndex);

    await assertComparisonUnreviewed(tx, context.aiResultId, context.assessmentIndex);

    if (data.otherClaimId !== context.assessment.otherClaimId) {
      throw new OtherClaimNotAPersistedAssessmentError();
    }

    // Re-assert the direction-required-iff-directional rule server-side
    // -- the schema's own .refine() already enforces this on the parsed
    // input, but this is the single point where the admin's OWN
    // type/direction choice (not the AI's) becomes authoritative, so it
    // is asserted again here rather than trusted transitively.
    const isDirectional = DIRECTIONAL_RELATIONSHIP_TYPES.has(data.relationshipType);
    const isSymmetric = SYMMETRIC_RELATIONSHIP_TYPES.has(data.relationshipType);
    if (!isDirectional && !isSymmetric) {
      throw new Error(`approveClaimComparisonWithChanges invariant violation: unrecognized relationshipType '${data.relationshipType}'.`);
    }
    if (isDirectional && data.direction === undefined) {
      throw new Error("approveClaimComparisonWithChanges invariant violation: direction is required for a directional relationshipType.");
    }

    return writeApproval({
      tx,
      admin,
      aiResultId: context.aiResultId,
      assessmentIndex: context.assessmentIndex,
      focusClaimId: context.focusClaimId,
      otherClaimId: context.assessment.otherClaimId,
      relationshipType: data.relationshipType,
      direction: data.direction ?? null,
      confidence: context.assessment.confidence,
      decisionAction: "edit",
      reason: data.reason ?? null,
      aiProposedMetadata: {
        aiProposedRelationshipType: context.assessment.relationshipType,
        aiProposedDirection: context.assessment.direction,
      },
    });
  });
}

/** Rejection remains auditable but creates no claim_relationships row, no status-ledger entry, and no relationship snapshot. */
export async function rejectClaimComparison(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = rejectClaimComparisonSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const context = await getComparisonAssessment(tx, data.aiResultId, data.assessmentIndex);
    if (!context) throw new ComparisonAssessmentNotFoundError(data.aiResultId, data.assessmentIndex);

    await assertComparisonUnreviewed(tx, context.aiResultId, context.assessmentIndex);

    const [decision] = await tx
      .insert(adminDecisions)
      .values({ aiResultId: context.aiResultId, adminUserId: admin.id, action: "reject", notes: data.notes ?? null })
      .returning();

    const [review] = await tx
      .insert(claimComparisonReviews)
      .values({
        aiResultId: context.aiResultId,
        assessmentIndex: context.assessmentIndex,
        adminDecisionId: decision.id,
        // All five snapshot columns NULL -- a rejection materializes no
        // relationship, per claim_comparison_reviews_approval_snapshot_complete.
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "claim_comparison_review",
      entityId: review.id,
      summary: `Rejected comparison assessment ${context.assessmentIndex} from AI result #${context.aiResultId}`,
      metadata: {
        aiResultId: context.aiResultId,
        assessmentIndex: context.assessmentIndex,
        aiProposedRelationshipType: context.assessment.relationshipType,
        aiProposedOtherClaimId: context.assessment.otherClaimId,
      },
    });

    return { review };
  });
}
