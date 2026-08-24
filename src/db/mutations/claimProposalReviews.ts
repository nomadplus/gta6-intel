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
import { buildExtractClaimsOutputSchema, type ExtractClaimsOutput } from "@/lib/ai/operations/extractClaims";
import { approveClaimProposalSchema, rejectClaimProposalSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { isUniqueViolation, logAdminAction, withAuditedTransaction } from "./shared";

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

type ProposalContext = {
  aiResultId: number;
  candidateIndex: number;
  sourceItemId: number;
  candidate: ExtractClaimsOutput["claims"][number];
};

/**
 * Re-reads the persisted AI result and source item; no candidate content,
 * source id, or supporting excerpt is accepted from an HTML form. This keeps
 * the provenance link tied to the exact successful extraction a human saw.
 */
async function getProposalContext(aiResultId: number, candidateIndex: number): Promise<ProposalContext> {
  const rows = await adminDb
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
  if (!row) throw new ClaimProposalNotFoundError();

  const parsed = buildExtractClaimsOutputSchema({
    id: row.sourceItemId,
    url: "",
    title: row.sourceTitle,
    excerpt: row.sourceExcerpt,
  }).safeParse(row.structuredOutput);
  const candidate = parsed.success ? parsed.data.claims[candidateIndex] : undefined;
  if (!candidate) throw new ClaimProposalNotFoundError();

  return { aiResultId: row.aiResultId, candidateIndex, sourceItemId: row.sourceItemId, candidate };
}

async function assertProposalIsUnreviewed(aiResultId: number, candidateIndex: number) {
  const rows = await adminDb
    .select({ id: claimProposalReviews.id })
    .from(claimProposalReviews)
    .where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, candidateIndex)))
    .limit(1);
  if (rows[0]) throw new ClaimProposalAlreadyReviewedError();
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
  const proposal = await getProposalContext(data.aiResultId, data.candidateIndex);
  await assertProposalIsUnreviewed(proposal.aiResultId, proposal.candidateIndex);

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
  const proposal = await getProposalContext(data.aiResultId, data.candidateIndex);
  await assertProposalIsUnreviewed(proposal.aiResultId, proposal.candidateIndex);

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
