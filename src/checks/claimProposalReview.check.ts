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
 * Phase 6 PR-B adds a mutation-boundary proof: an officialBasis value
 * sitting in a persisted extraction proposal cannot alter what gets
 * written to `claims` (there is no such column), never overrides the
 * human-submitted informationType, and has no effect on approval
 * outcome regardless of its value. This does not invoke extractClaims()
 * or any AI provider -- it only proves what the mutation layer does with
 * a fixture ai_results row already shaped as if extractClaims had
 * produced it.
 *
 * It also adds a direct backward-compatibility proof: a candidate
 * persisted with NO officialBasis key at all (the genuine pre-PR-B
 * shape) remains fully ACTIONABLE -- approve, reject, AND link-to-
 * existing-claim all succeed via getExtractionCandidate()'s tolerant
 * buildPersistedExtractClaimsOutputSchema, not merely displayable via
 * the admin list query. See detectDuplicatesOrchestration.check.ts for
 * the equivalent proof on the detect_duplicates trigger path.
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
  resolveProposalAsExistingClaim,
  ExistingClaimNotAPersistedMatchError,
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

    // =====================================================================
    // Phase 5 PR 6: "Use existing claim" human resolution
    // =====================================================================
    console.log("\n=== resolveProposalAsExistingClaim (Phase 5 PR 6) ===\n");

    /** One genuine extraction candidate + a genuine succeeded detect_duplicates result naming `matchClaimId` as a persisted match, for resolveProposalAsExistingClaim to reference. */
    async function createCandidateWithDuplicateMatch(statement: string, matchClaimId: number) {
      const url = `https://example.test/pr6-resolve-${randomUUID()}`;
      const [candidateSourceItem] = await db
        .insert(sourceItems)
        .values({ sourceId: 1, itemTypeId: 1, url, normalizedUrl: url, title: "PR6 use-existing-claim fixture", excerpt: statement })
        .returning();
      const [candidateJob] = await db
        .insert(aiJobs)
        .values({ operation: "extract_claims", provider: "fake", model: "test-model", status: "succeeded", sourceItemId: candidateSourceItem.id, completedAt: new Date() })
        .returning();
      const [candidateResult] = await db
        .insert(aiResults)
        .values({ aiJobId: candidateJob.id, structuredOutput: { claims: [{ statement, informationType: "report", supportingExcerpt: statement, confidence: 0.9, reasoning: "fixture" }] } })
        .returning();

      const [ddJob] = await db
        .insert(aiJobs)
        .values({ operation: "detect_duplicates", provider: "fake", model: "test-model", status: "succeeded", extractionAiResultId: candidateResult.id, extractionCandidateIndex: 0, completedAt: new Date() })
        .returning();
      await db.insert(aiResults).values({ aiJobId: ddJob.id, structuredOutput: { matches: [{ existingClaimId: matchClaimId, confidence: 0.9, reasoning: "fixture match" }] } });

      return { aiResultId: candidateResult.id, sourceItemId: candidateSourceItem.id };
    }

    async function createFixtureClaim(statement: string): Promise<number> {
      const [row] = await db.insert(claims).values({ projectId: 1, slug: `pr6-resolve-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
      return row.id;
    }

    // --- tampered existingClaimId: rejected ------------------------------
    {
      const existingClaimId = await createFixtureClaim("GTA VI features a coastal city district.");
      const otherClaimId = await createFixtureClaim("GTA VI features a mountain region.");
      const { aiResultId } = await createCandidateWithDuplicateMatch("The map has a coastal city area.", existingClaimId);

      let tamperThrew = false;
      try {
        // otherClaimId was never a persisted match for THIS candidate.
        await resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId: otherClaimId, reason: "tampered id" });
      } catch (err) {
        tamperThrew = err instanceof ExistingClaimNotAPersistedMatchError;
      }
      assert(tamperThrew, "tampered existingClaimId (not a persisted match for this candidate) is rejected");

      const reviewRows = await db.select().from(claimProposalReviews).where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(reviewRows.length === 0, "tampered existingClaimId: no review row was created");
    }

    // --- successful resolution: provenance attached, review closed, no status-history mutation ---
    {
      const existingClaimId = await createFixtureClaim("GTA VI includes a functioning subway system.");
      const { aiResultId, sourceItemId } = await createCandidateWithDuplicateMatch("The game has a working metro/subway.", existingClaimId);

      const invBefore = await db.select().from(claimInvestigationStatusHistory).where(eq(claimInvestigationStatusHistory.claimId, existingClaimId));
      const devBefore = await db.select().from(claimDevelopmentOutcomeHistory).where(eq(claimDevelopmentOutcomeHistory.claimId, existingClaimId));
      assert(invBefore.length === 0 && devBefore.length === 0, "setup: the existing claim has no status history yet");

      const resolved = await resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "Same underlying subway fact." });
      assert(resolved.existingClaim.id === existingClaimId, "successful resolution: returns the existing (not a new) claim");

      const decisionRows = await db
        .select({ action: adminDecisions.action, materializedClaimId: claimProposalReviews.materializedClaimId })
        .from(claimProposalReviews)
        .innerJoin(adminDecisions, eq(adminDecisions.id, claimProposalReviews.adminDecisionId))
        .where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(decisionRows.length === 1, "successful resolution: exactly one review row exists");
      assert(decisionRows[0]?.action === "link_existing_claim", "successful resolution: admin_decisions.action is 'link_existing_claim'");
      assert(decisionRows[0]?.materializedClaimId === existingClaimId, "successful resolution: materializedClaimId references the EXISTING claim, not a new one");

      const linkRows = await db.select().from(claimSources).where(and(eq(claimSources.claimId, existingClaimId), eq(claimSources.sourceItemId, sourceItemId)));
      assert(linkRows.length === 1, "successful resolution: exactly one claim_sources provenance link was created");
      assert(linkRows[0]?.stance === "supports", "successful resolution: the new link's stance is 'supports'");

      const claimCountAfterResolve = await db.select({ count: sql<number>`count(*)::int` }).from(claims);
      const invAfter = await db.select().from(claimInvestigationStatusHistory).where(eq(claimInvestigationStatusHistory.claimId, existingClaimId));
      const devAfter = await db.select().from(claimDevelopmentOutcomeHistory).where(eq(claimDevelopmentOutcomeHistory.claimId, existingClaimId));
      assert(invAfter.length === 0, "successful resolution: NO investigation-status-history row was created for the existing claim");
      assert(devAfter.length === 0, "successful resolution: NO development-outcome-history row was created for the existing claim");
      void claimCountAfterResolve;

      // --- already-reviewed: cannot be resolved (or approved/rejected) again ---
      let secondThrew = false;
      try {
        await resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "second attempt" });
      } catch (err) {
        secondThrew = err instanceof ClaimProposalAlreadyReviewedError;
      }
      assert(secondThrew, "a resolved candidate cannot be resolved again");

      // --- idempotent already-linked source: no overwrite, resolution still closes ---
      const secondExistingClaimId = await createFixtureClaim("A second existing claim to test idempotent re-resolution against.");
      const { aiResultId: secondAiResultId } = await createCandidateWithDuplicateMatch("Another candidate statement for idempotency.", secondExistingClaimId);
      // Pre-link the same (claim, source item) pair the candidate itself would try to link -- using a DIFFERENT source item than the candidate's own, to isolate the idempotency check to claimSources' own (claimId, sourceItemId) uniqueness rather than reusing the same fixture twice.
      const { aiResultId: thirdAiResultId, sourceItemId: thirdSourceItemId } = await createCandidateWithDuplicateMatch("A candidate whose source item gets pre-linked.", secondExistingClaimId);
      const [preLinked] = await db
        .insert(claimSources)
        .values({ claimId: secondExistingClaimId, sourceItemId: thirdSourceItemId, stance: "supports", supportingExcerpt: "Pre-existing provenance text that must not be overwritten." })
        .returning();

      const idempotentResolved = await resolveProposalAsExistingClaim({ aiResultId: thirdAiResultId, candidateIndex: 0, existingClaimId: secondExistingClaimId, reason: "idempotent re-link" });
      assert(idempotentResolved.existingClaim.id === secondExistingClaimId, "idempotent resolution: still succeeds and closes the review even though the source was already linked");

      const linksAfterIdempotent = await db.select().from(claimSources).where(and(eq(claimSources.claimId, secondExistingClaimId), eq(claimSources.sourceItemId, thirdSourceItemId)));
      assert(linksAfterIdempotent.length === 1, "idempotent resolution: still exactly ONE claim_sources row for that (claim, source item) pair -- no duplicate insert");
      assert(
        linksAfterIdempotent[0]?.supportingExcerpt === "Pre-existing provenance text that must not be overwritten.",
        "idempotent resolution: the pre-existing supportingExcerpt is preserved verbatim, never overwritten"
      );
      assert(linksAfterIdempotent[0]?.id === preLinked.id, "idempotent resolution: the pre-existing claim_sources row itself is untouched (same id)");

      const secondReviewRows = await db
        .select({ action: adminDecisions.action })
        .from(claimProposalReviews)
        .innerJoin(adminDecisions, eq(adminDecisions.id, claimProposalReviews.adminDecisionId))
        .where(and(eq(claimProposalReviews.aiResultId, thirdAiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(secondReviewRows.length === 1 && secondReviewRows[0]?.action === "link_existing_claim", "idempotent resolution: the review still closes normally as link_existing_claim");
      void secondAiResultId;
    }

    // --- concurrent approve-new vs use-existing-claim: exactly one wins --
    {
      const existingClaimId = await createFixtureClaim("A claim used as the 'existing' side of a race.");
      const { aiResultId } = await createCandidateWithDuplicateMatch("A race-condition fixture candidate statement.", existingClaimId);

      const [approveOutcome, resolveOutcome] = await Promise.allSettled([
        approveClaimProposal({
          aiResultId,
          candidateIndex: 0,
          projectId: 1,
          statement: "A race-condition fixture candidate statement.",
          slug: `pr6-race-approve-${randomUUID()}`,
          informationType: "report",
          topicIds: [],
          initialInvestigationStatus: "unverified",
          initialDevelopmentOutcome: "unknown",
          reason: "racing approval",
        }),
        resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "racing resolution" }),
      ]);

      const outcomes = [approveOutcome, resolveOutcome];
      const wins = outcomes.filter((o) => o.status === "fulfilled");
      const losses = outcomes.filter((o) => o.status === "rejected");
      assert(wins.length === 1, `approve-vs-use-existing race: exactly one attempt wins (got ${wins.length})`);
      assert(losses.length === 1, `approve-vs-use-existing race: exactly one attempt loses (got ${losses.length})`);
      if (losses[0]?.status === "rejected") {
        assert(losses[0].reason instanceof ClaimProposalAlreadyReviewedError, "approve-vs-use-existing race: the losing attempt fails with ClaimProposalAlreadyReviewedError");
      }
      const finalReviewRows = await db.select().from(claimProposalReviews).where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(finalReviewRows.length === 1, "approve-vs-use-existing race: exactly one terminal review row exists for this candidate");
    }

    // --- concurrent reject vs use-existing-claim: exactly one wins -------
    {
      const existingClaimId = await createFixtureClaim("Another claim used as the 'existing' side of a second race.");
      const { aiResultId } = await createCandidateWithDuplicateMatch("A second race-condition fixture candidate statement.", existingClaimId);

      const [rejectOutcome, resolveOutcome] = await Promise.allSettled([
        rejectClaimProposal({ aiResultId, candidateIndex: 0, notes: "racing rejection" }),
        resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "racing resolution" }),
      ]);

      const outcomes = [rejectOutcome, resolveOutcome];
      const wins = outcomes.filter((o) => o.status === "fulfilled");
      const losses = outcomes.filter((o) => o.status === "rejected");
      assert(wins.length === 1, `reject-vs-use-existing race: exactly one attempt wins (got ${wins.length})`);
      assert(losses.length === 1, `reject-vs-use-existing race: exactly one attempt loses (got ${losses.length})`);
      if (losses[0]?.status === "rejected") {
        assert(losses[0].reason instanceof ClaimProposalAlreadyReviewedError, "reject-vs-use-existing race: the losing attempt fails with ClaimProposalAlreadyReviewedError");
      }
      const finalReviewRows = await db.select().from(claimProposalReviews).where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(finalReviewRows.length === 1, "reject-vs-use-existing race: exactly one terminal review row exists for this candidate");
    }

    // --- forced failure after a newly-created source link rolls back everything ---
    {
      const existingClaimId = await createFixtureClaim("A claim targeted by a deliberately-forced resolution failure.");
      const { aiResultId, sourceItemId } = await createCandidateWithDuplicateMatch("A forced-failure fixture candidate statement.", existingClaimId);

      const linksBefore = await db.select({ count: sql<number>`count(*)::int` }).from(claimSources).where(and(eq(claimSources.claimId, existingClaimId), eq(claimSources.sourceItemId, sourceItemId)));
      assert(linksBefore[0]?.count === 0, "forced failure setup: no source link exists yet");

      // Force the failure the same way the real transaction would
      // naturally fail: pre-insert the terminal claim_proposal_reviews
      // row for this exact candidate BEFORE calling
      // resolveProposalAsExistingClaim, using an admin_decisions row of
      // our own -- so resolveProposalAsExistingClaim's own
      // claim_proposal_reviews insert (which happens AFTER the source
      // link insert inside its transaction) is guaranteed to violate
      // claim_proposal_reviews_candidate_unique, exercising a genuine
      // late-transaction failure after the source link write already
      // happened in the SAME transaction attempt.
      const [forcedDecision] = await db.insert(adminDecisions).values({ aiResultId, adminUserId: 1, action: "reject", notes: "forced pre-existing decision to trigger a late rollback" }).returning();
      await db.insert(claimProposalReviews).values({ aiResultId, candidateIndex: 0, adminDecisionId: forcedDecision.id });

      let forcedFailureThrew = false;
      try {
        await resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "should roll back entirely" });
      } catch (err) {
        forcedFailureThrew = err instanceof ClaimProposalAlreadyReviewedError;
      }
      assert(forcedFailureThrew, "forced failure: resolveProposalAsExistingClaim throws (via the pre-existing review row's unique-constraint collision)");

      const linksAfter = await db.select({ count: sql<number>`count(*)::int` }).from(claimSources).where(and(eq(claimSources.claimId, existingClaimId), eq(claimSources.sourceItemId, sourceItemId)));
      assert(linksAfter[0]?.count === 0, "forced failure: the whole transaction rolled back -- the source link created earlier in the SAME failed attempt was NOT left committed");

      const reviewRowsAfter = await db.select().from(claimProposalReviews).where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, 0)));
      assert(reviewRowsAfter.length === 1, "forced failure: only the ORIGINAL forced review row exists -- resolveProposalAsExistingClaim's own attempted review row was rolled back, not left as a second row");
    }
    // =====================================================================
    // Phase 6 PR-B: officialBasis mutation-boundary proof
    // =====================================================================
    // Focused on MUTATION semantics only -- this does not invoke extractClaims()
    // or any AI provider. It proves that an advisory officialBasis value sitting
    // in a persisted extraction proposal (1) has no persistence path into
    // `claims` (there is no such column, and approveClaimProposalSchema has no
    // such field), (2) never overrides the human-submitted informationType, and
    // (3) has no effect on approval outcome regardless of its value.
    console.log("\n=== officialBasis mutation-boundary proof (Phase 6 PR-B) ===\n");

    /** One extract_claims-shaped ai_results row carrying officialBasis, for the mutation-boundary proof below. */
    async function createProposalWithOfficialBasis(officialBasis: string, aiInformationType: string) {
      const url = `https://example.test/pr-b-official-basis-${randomUUID()}`;
      const [proposalSourceItem] = await db
        .insert(sourceItems)
        .values({ sourceId: 1, itemTypeId: 1, url, normalizedUrl: url, title: "PR-B officialBasis fixture", excerpt: "Rockstar Games confirmed a new gameplay feature." })
        .returning();
      const [proposalJob] = await db
        .insert(aiJobs)
        .values({ operation: "extract_claims", provider: "fake", model: "test-model", status: "succeeded", sourceItemId: proposalSourceItem.id, completedAt: new Date() })
        .returning();
      const [proposalResult] = await db
        .insert(aiResults)
        .values({
          aiJobId: proposalJob.id,
          structuredOutput: {
            claims: [
              {
                statement: "Rockstar Games confirmed a new gameplay feature.",
                informationType: aiInformationType,
                supportingExcerpt: "Rockstar Games confirmed a new gameplay feature.",
                confidence: 0.8,
                reasoning: "fixture",
                officialBasis,
              },
            ],
          },
        })
        .returning();
      return { aiResultId: proposalResult.id };
    }

    // --- human-submitted informationType persists to claims; the AI's own
    //     informationType and officialBasis do not override it -----------
    {
      const { aiResultId } = await createProposalWithOfficialBasis("reported_official_material", "report");
      const approvedWithOverride = await approveClaimProposal({
        aiResultId,
        candidateIndex: 0,
        projectId: 1,
        // Deliberately DIFFERENT from the AI's proposed "report" above --
        // this is the human reviewer's edit, exactly as CandidateDetail.tsx's
        // form allows (defaultValue pre-filled from the AI, but submitted
        // value is whatever the human left in the field).
        statement: "Rockstar Games officially confirmed a new gameplay feature.",
        slug: `pr-b-official-basis-override-${suffix}`,
        informationType: "official",
        topicIds: [],
        initialInvestigationStatus: "confirmed",
        initialDevelopmentOutcome: "not_applicable",
        reason: "Human reviewer upgraded informationType from the AI's proposed 'report' to 'official' after independently verifying the source.",
      });

      assert(
        approvedWithOverride.claim.informationType === "official",
        "mutation boundary: the HUMAN-submitted informationType ('official') is what gets persisted, not the AI's proposed value ('report')"
      );

      const [claimRow] = await db.select().from(claims).where(eq(claims.id, approvedWithOverride.claim.id));
      assert(claimRow?.informationType === "official", "mutation boundary: the persisted claims row itself carries the human-submitted informationType");
      assert(
        !("officialBasis" in (claimRow as Record<string, unknown>)),
        "mutation boundary: the persisted claims row has no officialBasis column/property at all -- there is no such column in the schema"
      );

      const [persistedResult] = await db.select().from(aiResults).where(eq(aiResults.id, aiResultId));
      const persistedStructured = persistedResult?.structuredOutput as { claims: { officialBasis?: string }[] } | undefined;
      assert(
        persistedStructured?.claims[0]?.officialBasis === "reported_official_material",
        "mutation boundary: officialBasis remains exactly as originally proposed in ai_results.structured_output -- untouched by approval, not consumed or cleared"
      );
    }

    // --- officialBasis's VALUE has no causal effect on approval outcome:
    //     two otherwise-identical proposals, differing ONLY in officialBasis,
    //     approved with the SAME human-submitted informationType, produce
    //     identical persisted informationType -----------------------------
    {
      const proposalA = await createProposalWithOfficialBasis("direct_official_material", "official");
      const proposalB = await createProposalWithOfficialBasis("not_applicable_or_unclear", "official");

      const claimA = await approveClaimProposal({
        aiResultId: proposalA.aiResultId,
        candidateIndex: 0,
        projectId: 1,
        statement: "Rockstar Games officially confirmed a new gameplay feature (A).",
        slug: `pr-b-official-basis-a-${suffix}`,
        informationType: "official",
        topicIds: [],
        initialInvestigationStatus: "confirmed",
        initialDevelopmentOutcome: "not_applicable",
        reason: "Approving candidate A for the officialBasis-has-no-effect proof.",
      });
      const claimB = await approveClaimProposal({
        aiResultId: proposalB.aiResultId,
        candidateIndex: 0,
        projectId: 1,
        statement: "Rockstar Games officially confirmed a new gameplay feature (B).",
        slug: `pr-b-official-basis-b-${suffix}`,
        informationType: "official",
        topicIds: [],
        initialInvestigationStatus: "confirmed",
        initialDevelopmentOutcome: "not_applicable",
        reason: "Approving candidate B for the officialBasis-has-no-effect proof.",
      });

      assert(
        claimA.claim.informationType === claimB.claim.informationType,
        "mutation boundary: candidates differing ONLY in officialBasis ('direct_official_material' vs 'not_applicable_or_unclear'), approved with the same human informationType, persist identical informationType -- officialBasis's value has zero causal effect on approval"
      );
    }

    // =====================================================================
    // Phase 6 PR-B: legacy (pre-PR-B) candidates remain ACTIONABLE, not
    // merely displayable, through getExtractionCandidate()
    // =====================================================================
    // Direct regression proof for the buildPersistedExtractClaimsOutputSchema
    // fix: a candidate persisted BEFORE officialBasis existed (no such key
    // anywhere in structured_output -- the genuine historical shape, not a
    // deliberately-blanked field) must still be resolvable by
    // getExtractionCandidate() and therefore fully actionable -- approve,
    // reject, AND link-to-existing-claim -- not silently treated as "not
    // found" merely because a field that didn't exist yet at write time is
    // now required for a NEW extraction. Each action below uses its own
    // isolated candidate so the append-only "one review per candidate"
    // constraint can't make these three proofs interfere with each other.
    console.log("\n=== legacy (pre-PR-B) candidate actionability (Phase 6 PR-B) ===\n");

    /**
     * One extract_claims-shaped ai_results row with NO officialBasis key
     * anywhere -- the genuine pre-PR-B historical shape, not this PR's
     * new field merely left undefined by a test author's oversight.
     */
    async function createLegacyExtractionCandidate(statement: string) {
      const url = `https://example.test/pr-b-legacy-${randomUUID()}`;
      const [legacySourceItem] = await db
        .insert(sourceItems)
        .values({ sourceId: 1, itemTypeId: 1, url, normalizedUrl: url, title: "PR-B legacy-row fixture", excerpt: statement })
        .returning();
      const [legacyJob] = await db
        .insert(aiJobs)
        .values({ operation: "extract_claims", provider: "fake", model: "test-model", status: "succeeded", sourceItemId: legacySourceItem.id, completedAt: new Date() })
        .returning();
      const [legacyResult] = await db
        .insert(aiResults)
        .values({
          aiJobId: legacyJob.id,
          structuredOutput: {
            claims: [
              {
                statement,
                informationType: "report",
                supportingExcerpt: statement,
                confidence: 0.85,
                reasoning: "legacy fixture, pre-PR-B shape",
                // officialBasis deliberately absent entirely -- not present,
                // not null, not undefined-as-a-value -- the key itself does
                // not exist, exactly like a row written before this PR.
              },
            ],
          },
        })
        .returning();
      return { aiResultId: legacyResult.id, sourceItemId: legacySourceItem.id };
    }

    // --- legacy candidate: approveClaimProposal() succeeds ------------------
    {
      const { aiResultId } = await createLegacyExtractionCandidate("Legacy candidate A: GTA VI includes an in-game radio station parody.");
      const approvedLegacy = await approveClaimProposal({
        aiResultId,
        candidateIndex: 0,
        projectId: 1,
        statement: "GTA VI includes an in-game radio station parody.",
        slug: `pr-b-legacy-approve-${suffix}`,
        informationType: "report",
        topicIds: [],
        initialInvestigationStatus: "unverified",
        initialDevelopmentOutcome: "unknown",
        reason: "Approving a legacy (no officialBasis) candidate to prove it is actionable, not just displayable.",
      });
      assert(approvedLegacy.claim.id > 0, "legacy candidate: approveClaimProposal() succeeds and creates a real claim");
    }

    // --- legacy candidate: rejectClaimProposal() succeeds -------------------
    {
      const { aiResultId } = await createLegacyExtractionCandidate("Legacy candidate B: GTA VI includes a working ferry system.");
      const rejectedLegacy = await rejectClaimProposal({
        aiResultId,
        candidateIndex: 0,
        notes: "Rejecting a legacy (no officialBasis) candidate to prove it is actionable, not just displayable.",
      });
      assert(rejectedLegacy.review.materializedClaimId === null, "legacy candidate: rejectClaimProposal() succeeds with no materialized claim");
    }

    // --- legacy candidate: resolveProposalAsExistingClaim() succeeds -------
    {
      const existingClaimId = await createFixtureClaim("GTA VI includes a functioning tram network.");
      // Reuses the pre-existing Phase 5 PR 6 helper directly -- its fixture
      // was ALREADY legacy-shaped (no officialBasis) before this PR-B
      // session touched anything, which is exactly the historical shape
      // this proof needs; no separate helper is required here.
      const { aiResultId } = await createCandidateWithDuplicateMatch("Legacy candidate C: the game has a working tram/rail network.", existingClaimId);

      const resolvedLegacy = await resolveProposalAsExistingClaim({
        aiResultId,
        candidateIndex: 0,
        existingClaimId,
        reason: "Resolving a legacy (no officialBasis) candidate to an existing claim to prove it is actionable, not just displayable.",
      });
      assert(
        resolvedLegacy.review.materializedClaimId === existingClaimId,
        "legacy candidate: resolveProposalAsExistingClaim() succeeds and links to the existing claim"
      );
    }
  } finally {
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll claim-proposal review checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
