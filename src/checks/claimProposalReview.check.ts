/**
 * Phase 5 PR 5 regression check: one successful extract_claims result can
 * contain several independent candidates. This exercises the real, guarded
 * approval/rejection mutations against a local database without invoking an
 * AI provider.
 *
 * It proves that:
 * - an approval creates a claim, its two initial status-ledger rows, and one
 *   claim_sources provenance link in a single persisted decision trail;
 * - a rejection records a candidate decision but creates no claim, evidence,
 *   or provenance record;
 * - a candidate cannot be reviewed twice.
 *
 * Run with: npx tsx --conditions=react-server src/checks/claimProposalReview.check.ts
 * Requires the local-only check environment documented in README.md.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  adminDecisions,
  aiJobs,
  aiResults,
  claimDevelopmentOutcomeHistory,
  claimProposalReviews,
  claimSources,
  claimInvestigationStatusHistory,
  claims,
  evidence,
  sourceItems,
} from "../db/schema";
import {
  approveClaimProposal,
  ClaimProposalAlreadyReviewedError,
  rejectClaimProposal,
} from "../db/mutations/claimProposalReviews";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
}

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
  const suffix = randomUUID();

  try {
    console.log("=== claim-proposal review (Phase 5 PR 5) -- DB only, no AI call ===\n");

    const sourceExcerpt = "Rockstar Games said Grand Theft Auto VI will launch on November 19, 2026.";
    const [sourceItem] = await db
      .insert(sourceItems)
      .values({
        sourceId: 1,
        itemTypeId: 1,
        url: `https://example.test/pr5-review-${suffix}`,
        normalizedUrl: `https://example.test/pr5-review-${suffix}`,
        title: "PR5 proposal-review fixture",
        excerpt: sourceExcerpt,
      })
      .returning();
    const [job] = await db
      .insert(aiJobs)
      .values({
        operation: "extract_claims",
        provider: "fake",
        model: "test-model",
        status: "succeeded",
        sourceItemId: sourceItem.id,
        completedAt: new Date(),
      })
      .returning();
    const [result] = await db
      .insert(aiResults)
      .values({
        aiJobId: job.id,
        structuredOutput: {
          claims: [
            {
              statement: "Grand Theft Auto VI will launch on November 19, 2026.",
              informationType: "official",
              supportingExcerpt: "Grand Theft Auto VI will launch on November 19, 2026.",
              confidence: 0.98,
              reasoning: "The official statement explicitly gives the release date.",
            },
            {
              statement: "Rockstar Games announced the Grand Theft Auto VI release date.",
              informationType: "official",
              supportingExcerpt: "Rockstar Games said",
              confidence: 0.91,
              reasoning: "The source explicitly attributes the announcement to Rockstar Games.",
            },
          ],
        },
      })
      .returning();

    const beforeEvidence = await db.select({ count: sql<number>`count(*)::int` }).from(evidence);
    const approved = await approveClaimProposal({
      aiResultId: result.id,
      candidateIndex: 0,
      projectId: 1,
      statement: "Grand Theft Auto VI will launch on November 19, 2026.",
      slug: `pr5-launch-${suffix}`,
      informationType: "official",
      topicIds: [],
      initialInvestigationStatus: "confirmed",
      initialDevelopmentOutcome: "not_applicable",
      reason: "Official Rockstar statement directly supports the release-date claim.",
    });

    assert(approved.claim.id > 0, "approval creates a real claim");
    const approvedReviewRows = await db
      .select({ action: adminDecisions.action, materializedClaimId: claimProposalReviews.materializedClaimId })
      .from(claimProposalReviews)
      .innerJoin(adminDecisions, eq(adminDecisions.id, claimProposalReviews.adminDecisionId))
      .where(and(eq(claimProposalReviews.aiResultId, result.id), eq(claimProposalReviews.candidateIndex, 0)));
    assert(approvedReviewRows.length === 1, "approval records exactly one review for candidate 1");
    assert(approvedReviewRows[0]?.action === "approve", "approval decision action is approve");
    assert(approvedReviewRows[0]?.materializedClaimId === approved.claim.id, "review links to the materialized claim");

    const sourceLinks = await db
      .select()
      .from(claimSources)
      .where(and(eq(claimSources.claimId, approved.claim.id), eq(claimSources.sourceItemId, sourceItem.id)));
    assert(sourceLinks.length === 1, "approval creates exactly one claim/source provenance link");
    assert(sourceLinks[0]?.supportingExcerpt === "Grand Theft Auto VI will launch on November 19, 2026.", "provenance excerpt is re-read from the persisted AI result");

    const invHistory = await db.select().from(claimInvestigationStatusHistory).where(eq(claimInvestigationStatusHistory.claimId, approved.claim.id));
    const devHistory = await db.select().from(claimDevelopmentOutcomeHistory).where(eq(claimDevelopmentOutcomeHistory.claimId, approved.claim.id));
    assert(invHistory.length === 1 && invHistory[0]?.newStatus === "confirmed", "approval creates the chosen investigation-status ledger row");
    assert(devHistory.length === 1 && devHistory[0]?.newOutcome === "not_applicable", "approval creates the chosen development-outcome ledger row");
    assert(invHistory[0]?.adminDecisionId === approved.review.adminDecisionId && devHistory[0]?.adminDecisionId === approved.review.adminDecisionId, "both initial status rows point to the candidate approval decision");

    let duplicateThrew = false;
    try {
      await approveClaimProposal({
        aiResultId: result.id,
        candidateIndex: 0,
        projectId: 1,
        statement: "A second attempt must not create a claim.",
        slug: `pr5-duplicate-${suffix}`,
        informationType: "official",
        reason: "This should be rejected before any write.",
      });
    } catch (err) {
      duplicateThrew = err instanceof ClaimProposalAlreadyReviewedError;
    }
    assert(duplicateThrew, "a reviewed candidate cannot be approved twice");

    const claimCountBeforeReject = await db.select({ count: sql<number>`count(*)::int` }).from(claims);
    const sourceLinkCountBeforeReject = await db.select({ count: sql<number>`count(*)::int` }).from(claimSources);
    const rejected = await rejectClaimProposal({
      aiResultId: result.id,
      candidateIndex: 1,
      notes: "This administrative-announcement proposition is redundant with the release-date claim.",
    });
    assert(rejected.review.materializedClaimId === null, "rejection has no materialized claim");
    const rejectedReviewRows = await db
      .select({ action: adminDecisions.action })
      .from(claimProposalReviews)
      .innerJoin(adminDecisions, eq(adminDecisions.id, claimProposalReviews.adminDecisionId))
      .where(and(eq(claimProposalReviews.aiResultId, result.id), eq(claimProposalReviews.candidateIndex, 1)));
    assert(rejectedReviewRows.length === 1 && rejectedReviewRows[0]?.action === "reject", "rejection is permanently recorded for candidate 2");

    const claimCountAfterReject = await db.select({ count: sql<number>`count(*)::int` }).from(claims);
    const sourceLinkCountAfterReject = await db.select({ count: sql<number>`count(*)::int` }).from(claimSources);
    const afterEvidence = await db.select({ count: sql<number>`count(*)::int` }).from(evidence);
    assert(claimCountAfterReject[0]?.count === claimCountBeforeReject[0]?.count, "rejection creates no claim");
    assert(sourceLinkCountAfterReject[0]?.count === sourceLinkCountBeforeReject[0]?.count, "rejection creates no provenance link");
    assert(afterEvidence[0]?.count === beforeEvidence[0]?.count, "neither decision auto-creates evidence");
  } finally {
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll claim-proposal review checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
