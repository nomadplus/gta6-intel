import "server-only";
import { and, eq } from "drizzle-orm";
import {
  adminDecisions,
  aiJobs,
  aiResults,
  claimDevelopmentOutcomeHistory,
  claimProposalReviews,
  claimSources,
  claimTopics,
  claimInvestigationStatusHistory,
  claims,
  sourceItems,
} from "@/db/schema";
import { adminDb } from "@/db/adminClient";
import { buildPersistedExtractClaimsOutputSchema, type PersistedExtractClaimsOutput } from "@/lib/ai/operations/extractClaims";
import { approveClaimProposalSchema, rejectClaimProposalSchema, resolveAsExistingClaimSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { isProposalReviewed, getLatestDetectDuplicatesMatches, getClaimByIdForResolution } from "@/db/queries/admin";
import { insertClaimSourceLinkTx } from "./claimSources";
import { isUniqueViolation, logAdminAction, withAuditedTransaction, type DbExecutor } from "./shared";

export class ClaimProposalAlreadyReviewedError extends Error {
  constructor() {
    super("This claim proposal has already been reviewed.");
    this.name = "ClaimProposalAlreadyReviewedError";
  }
}

export class ClaimProposalNotFoundError extends Error {
  constructor() {
    super("This claim proposal no longer exists or was not produced by a successful extraction.");
    this.name = "ClaimProposalNotFoundError";
  }
}

export class ExistingClaimNotAPersistedMatchError extends Error {
  constructor() {
    super(
      "The submitted existing claim is not one of this candidate's persisted duplicate-check matches -- " +
        "resolution must reference a match this candidate's own latest successful duplicate check actually returned."
    );
    this.name = "ExistingClaimNotAPersistedMatchError";
  }
}

export class ExistingClaimNotFoundError extends Error {
  constructor(claimId: number) {
    super(`Claim #${claimId} could not be found -- cannot resolve a proposal to a claim that does not exist.`);
    this.name = "ExistingClaimNotFoundError";
  }
}

export type ProposalContext = {
  aiResultId: number;
  candidateIndex: number;
  sourceItemId: number;
  candidate: PersistedExtractClaimsOutput["claims"][number];
};

/**
 * Re-reads and re-validates the persisted AI result and source item; no
 * candidate content, source id, or supporting excerpt is ever accepted
 * from an HTML form or from a browser-supplied value. This keeps the
 * provenance link tied to the exact successful extraction a human (or,
 * for detectDuplicatesTrigger.ts's eligibility check, an orchestration
 * caller) saw.
 *
 * Deliberately NEUTRAL -- returns null rather than throwing when the
 * candidate cannot be resolved. This function needs extract_claims' own
 * Zod schema to parse the candidate out of stored JSON, which is why it
 * lives here rather than in the generic query layer
 * (src/db/queries/admin/index.ts) -- that module deliberately imports
 * nothing from src/lib/ai, so a helper that needs an AI operation's own
 * schema does not belong there. Both this file's own mutations below AND
 * src/lib/ai/operations/detectDuplicatesTrigger.ts import this function
 * directly and each throw their OWN domain error on a null result
 * (ClaimProposalNotFoundError here; a duplicate-check-specific error
 * there) -- one implementation, two error translations, exactly the
 * "orchestration/mutation layers own domain errors, this function owns
 * the read" split.
 *
 * Phase 6 PR-B: this re-validates PERSISTED output, not a fresh provider
 * response, so it deliberately uses buildPersistedExtractClaimsOutputSchema
 * (officialBasis optional) rather than the strict write-time
 * buildExtractClaimsOutputSchema (officialBasis required). A pre-PR-B
 * row genuinely has no officialBasis key -- using the strict schema here
 * would fail EVERY historical row's validation, which would make
 * approve/reject/link/duplicate-check all treat a perfectly legitimate,
 * still-unreviewed historical candidate as "not found." Every other
 * validation rule (supportingExcerpt literal-substring grounding,
 * exact-duplicate rejection, claims[] max length, informationType,
 * every field's length/range limits) is identical between the two
 * schemas -- see buildExtractClaimsSchemaInternal in extractClaims.ts --
 * so nothing else about historical-row validation is loosened.
 *
 * Accepts a DbExecutor so it can run either as a standalone read (plain
 * adminDb, e.g. detectDuplicatesTrigger.ts's eligibility check) or as
 * part of a larger atomic transaction (resolveProposalAsExistingClaim's
 * tx, re-verifying against transaction-consistent state rather than a
 * possibly-stale prior read).
 */
export async function getExtractionCandidate(
  db: DbExecutor,
  aiResultId: number,
  candidateIndex: number
): Promise<ProposalContext | null> {
  const rows = await db
    .select({
      aiResultId: aiResults.id,
      structuredOutput: aiResults.structuredOutput,
      sourceItemId: sourceItems.id,
      sourceTitle: sourceItems.title,
      sourceExcerpt: sourceItems.excerpt,
    })
    .from(aiResults)
    .innerJoin(aiJobs, eq(aiJobs.id, aiResults.aiJobId))
    .innerJoin(sourceItems, eq(sourceItems.id, aiJobs.sourceItemId))
    .where(and(eq(aiResults.id, aiResultId), eq(aiJobs.operation, "extract_claims"), eq(aiJobs.status, "succeeded")))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const parsed = buildPersistedExtractClaimsOutputSchema({
    id: row.sourceItemId,
    url: "",
    title: row.sourceTitle,
    excerpt: row.sourceExcerpt,
    // buildPersistedExtractClaimsOutputSchema, like the strict schema it
    // is built alongside, only ever reads title/excerpt (for the
    // supportingExcerpt literal-substring check) -- same reasoning as
    // the pre-existing url: "" placeholder above. sourceName/
    // sourceHomepageUrl are structurally required by ExtractableSourceItem
    // (they matter to buildUserPrompt(), which this re-validation path
    // never calls) but are never read here.
    sourceName: "",
    sourceHomepageUrl: null,
  }).safeParse(row.structuredOutput);
  const candidate = parsed.success ? parsed.data.claims[candidateIndex] : undefined;
  if (!candidate) return null;

  return { aiResultId: row.aiResultId, candidateIndex, sourceItemId: row.sourceItemId, candidate };
}

/**
 * Throwing wrapper around the neutral isProposalReviewed query fact --
 * this file's own domain error (ClaimProposalAlreadyReviewedError) is
 * thrown here, at the mutation layer, not inside the query helper itself.
 * Accepts a DbExecutor so resolveProposalAsExistingClaim can re-check this
 * against transaction-consistent state, inside its own transaction,
 * rather than trusting a read from before the transaction began.
 */
async function assertProposalIsUnreviewed(db: DbExecutor, aiResultId: number, candidateIndex: number): Promise<void> {
  if (await isProposalReviewed(db, aiResultId, candidateIndex)) {
    throw new ClaimProposalAlreadyReviewedError();
  }
}

function isProposalReviewUniqueViolation(err: unknown): boolean {
  if (!isUniqueViolation(err) || typeof err !== "object" || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  const constraint = cause && typeof cause === "object" ? (cause as { constraint?: unknown }).constraint : undefined;
  return constraint === "claim_proposal_reviews_candidate_unique";
}

/**
 * Approves one persisted extract_claims candidate. The result is a new claim
 * and one supporting claim_sources row, never an automatic evidence record.
 * Every write (the decision, two initial status-ledger rows, source link,
 * proposal bridge, and general audit rows) succeeds or rolls back together.
 */
export async function approveClaimProposal(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = approveClaimProposalSchema.parse(input);
  const proposal = await getExtractionCandidate(adminDb, data.aiResultId, data.candidateIndex);
  if (!proposal) throw new ClaimProposalNotFoundError();
  await assertProposalIsUnreviewed(adminDb, proposal.aiResultId, proposal.candidateIndex);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [claim] = await tx
        .insert(claims)
        .values({
          projectId: data.projectId,
          statement: data.statement,
          slug: data.slug,
          informationType: data.informationType,
          firstReportedAt: data.firstReportedAt,
        })
        .returning();

      for (const topicId of data.topicIds) {
        await tx.insert(claimTopics).values({ claimId: claim.id, topicId });
      }

      const [decision] = await tx
        .insert(adminDecisions)
        .values({
          aiResultId: proposal.aiResultId,
          adminUserId: admin.id,
          action: "approve",
          notes: data.reason,
        })
        .returning();

      await tx.insert(claimInvestigationStatusHistory).values({
        claimId: claim.id,
        previousStatus: null,
        newStatus: data.initialInvestigationStatus,
        reason: data.reason,
        initiatedBy: "human",
        adminDecisionId: decision.id,
      });
      await tx.insert(claimDevelopmentOutcomeHistory).values({
        claimId: claim.id,
        previousOutcome: null,
        newOutcome: data.initialDevelopmentOutcome,
        reason: data.reason,
        initiatedBy: "human",
        adminDecisionId: decision.id,
      });

      const [claimSource] = await tx
        .insert(claimSources)
        .values({
          claimId: claim.id,
          sourceItemId: proposal.sourceItemId,
          stance: "supports",
          supportingExcerpt: proposal.candidate.supportingExcerpt,
        })
        .returning();

      const [review] = await tx
        .insert(claimProposalReviews)
        .values({
          aiResultId: proposal.aiResultId,
          candidateIndex: proposal.candidateIndex,
          adminDecisionId: decision.id,
          materializedClaimId: claim.id,
        })
        .returning();

      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "claim",
        entityId: claim.id,
        summary: `Approved extraction candidate ${proposal.candidateIndex + 1} from AI result #${proposal.aiResultId} as claim #${claim.id}`,
      });
      await logAdminAction(tx, admin, {
        action: "link",
        entityType: "claim_source",
        entityId: claimSource.id,
        summary: `Linked source item #${proposal.sourceItemId} to approved claim #${claim.id} (supports)`,
      });
      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "claim_proposal_review",
        entityId: review.id,
        summary: `Approved extraction candidate ${proposal.candidateIndex + 1} from AI result #${proposal.aiResultId}`,
        metadata: { aiResultId: proposal.aiResultId, candidateIndex: proposal.candidateIndex, claimId: claim.id },
      });

      return { review, claim };
    });
  } catch (err) {
    if (isProposalReviewUniqueViolation(err)) throw new ClaimProposalAlreadyReviewedError();
    throw err;
  }
}

/** Rejection remains auditable but creates no claim, evidence, or provenance. */
export async function rejectClaimProposal(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = rejectClaimProposalSchema.parse(input);
  const proposal = await getExtractionCandidate(adminDb, data.aiResultId, data.candidateIndex);
  if (!proposal) throw new ClaimProposalNotFoundError();
  await assertProposalIsUnreviewed(adminDb, proposal.aiResultId, proposal.candidateIndex);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [decision] = await tx
        .insert(adminDecisions)
        .values({ aiResultId: proposal.aiResultId, adminUserId: admin.id, action: "reject", notes: data.notes })
        .returning();
      const [review] = await tx
        .insert(claimProposalReviews)
        .values({
          aiResultId: proposal.aiResultId,
          candidateIndex: proposal.candidateIndex,
          adminDecisionId: decision.id,
        })
        .returning();
      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "claim_proposal_review",
        entityId: review.id,
        summary: `Rejected extraction candidate ${proposal.candidateIndex + 1} from AI result #${proposal.aiResultId}`,
        metadata: { aiResultId: proposal.aiResultId, candidateIndex: proposal.candidateIndex },
      });
      return { review };
    });
  } catch (err) {
    if (isProposalReviewUniqueViolation(err)) throw new ClaimProposalAlreadyReviewedError();
    throw err;
  }
}

/**
 * Phase 5 PR 6: resolves one persisted extract_claims candidate to a
 * PRE-EXISTING claim, rather than materializing a new one -- the "Use
 * existing claim" human action. Attaches the candidate's source/excerpt
 * to the existing claim as provenance and closes out the review; never
 * mutates the existing claim's statement, investigation status, or
 * development outcome.
 *
 * Every one of the five correctness checks below re-reads
 * transaction-consistent state from WITHIN this function's one
 * transaction -- never trusting a value the browser submitted beyond
 * using it as a lookup key, and never trusting a page render from a
 * moment earlier as authorization:
 *   1. the candidate itself still resolves from the persisted extraction;
 *   2. the proposal has not already been reviewed by anyone;
 *   3. the exact existingClaimId submitted appears in THIS candidate's own
 *      latest successful persisted detect_duplicates result;
 *   4. (implied by 3 returning a match) the check in 3 IS the tamper-proof
 *      verification -- an invented/stale id simply won't appear;
 *   5. the existing claim still exists.
 * Only then does it write: the source link (idempotent -- see
 * insertClaimSourceLinkTx), the admin_decisions row
 * (action: 'link_existing_claim'), the claim_proposal_reviews row
 * (materializedClaimId = the EXISTING claim's id -- that column's FK
 * accepts any claims.id, new or pre-existing, with no CHECK constraint
 * tying it to a specific action -- confirmed by inspection of migration
 * 0016), and the two audit-log entries. All five writes are one
 * transaction; a failure at any point rolls back every write made so far
 * in this call, including a freshly-inserted (but not yet committed)
 * claim_sources row.
 */
export async function resolveProposalAsExistingClaim(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = resolveAsExistingClaimSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const proposal = await getExtractionCandidate(tx, data.aiResultId, data.candidateIndex);
      if (!proposal) throw new ClaimProposalNotFoundError();

      await assertProposalIsUnreviewed(tx, proposal.aiResultId, proposal.candidateIndex);

      const matches = await getLatestDetectDuplicatesMatches(tx, proposal.aiResultId, proposal.candidateIndex);
      const match = matches?.find((m) => m.existingClaimId === data.existingClaimId);
      if (!match) throw new ExistingClaimNotAPersistedMatchError();

      const existingClaim = await getClaimByIdForResolution(tx, data.existingClaimId);
      if (!existingClaim) throw new ExistingClaimNotFoundError(data.existingClaimId);

      const linkResult = await insertClaimSourceLinkTx(tx, {
        claimId: existingClaim.id,
        sourceItemId: proposal.sourceItemId,
        stance: "supports",
        supportingExcerpt: proposal.candidate.supportingExcerpt,
      });

      const [decision] = await tx
        .insert(adminDecisions)
        .values({
          aiResultId: proposal.aiResultId,
          adminUserId: admin.id,
          action: "link_existing_claim",
          notes: data.reason,
        })
        .returning();

      const [review] = await tx
        .insert(claimProposalReviews)
        .values({
          aiResultId: proposal.aiResultId,
          candidateIndex: proposal.candidateIndex,
          adminDecisionId: decision.id,
          materializedClaimId: existingClaim.id,
        })
        .returning();

      await logAdminAction(tx, admin, {
        action: "link",
        entityType: "claim_source",
        entityId: linkResult.link.id,
        summary: linkResult.wasNewLink
          ? `Linked source item #${proposal.sourceItemId} to existing claim #${existingClaim.id} (supports) via duplicate resolution`
          : `Source item #${proposal.sourceItemId} was already linked to existing claim #${existingClaim.id}; no new link created`,
      });
      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "claim_proposal_review",
        entityId: review.id,
        summary: `Resolved extraction candidate ${proposal.candidateIndex + 1} from AI result #${proposal.aiResultId} as existing claim #${existingClaim.id}`,
        metadata: {
          aiResultId: proposal.aiResultId,
          candidateIndex: proposal.candidateIndex,
          existingClaimId: existingClaim.id,
          createdNewSourceLink: linkResult.wasNewLink,
        },
      });

      return { review, existingClaim };
    });
  } catch (err) {
    if (isProposalReviewUniqueViolation(err)) throw new ClaimProposalAlreadyReviewedError();
    throw err;
  }
}
