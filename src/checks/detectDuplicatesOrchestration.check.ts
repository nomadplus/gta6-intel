/**
 * Regression check for Phase 5 PR 6's detect_duplicates eligibility gate
 * (src/lib/ai/operations/detectDuplicatesTrigger.ts's
 * triggerDetectDuplicates), its tiered retrieval strategy
 * (getDuplicateCheckRetrievalSet), and the pure six-state actionability
 * helper (src/lib/ai/duplicateCheckActionability.ts).
 *
 * Covers:
 *   - a reviewed candidate (approved, rejected, OR resolved to an
 *     existing claim) makes triggerDetectDuplicates throw
 *     ProposalAlreadyReviewedForDuplicateCheckError with ZERO new
 *     ai_jobs rows and ZERO provider calls, for all three review kinds
 *   - a candidate reviewed AFTER a successful duplicate check: the prior
 *     succeeded job/result remain historical and queryable, but a new
 *     attempt is blocked the same way
 *   - zero existing claims -> zero ai_jobs rows, zero provider calls,
 *     "no_existing_claims" outcome
 *   - a small claims table (<= threshold) sends every claim to the model
 *   - a claims table above the threshold sends only the bounded,
 *     pg_trgm-ranked subset
 *   - candidate-scoped in-flight concurrency race: two simultaneous
 *     triggerDetectDuplicates-shaped inserts for the SAME candidate,
 *     exactly one succeeds
 *   - all six DuplicateCheckDisplayState values compute correctly
 *
 * Run with: npx tsx --conditions=react-server src/checks/detectDuplicatesOrchestration.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and } from "drizzle-orm";
import { aiJobs, aiResults, sourceItems, claims, projects } from "../db/schema";
import {
  triggerDetectDuplicates,
  getDuplicateCheckRetrievalSet,
  ProposalAlreadyReviewedForDuplicateCheckError,
  DuplicateCheckCandidateNotFoundError,
  DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD,
  DUPLICATE_CHECK_PREFILTER_LIMIT,
  DUPLICATE_CHECK_DEFAULT_PROJECT_ID,
} from "../lib/ai/operations/detectDuplicatesTrigger";
import { approveClaimProposal, rejectClaimProposal, resolveProposalAsExistingClaim } from "../db/mutations/claimProposalReviews";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { FakeAiProvider } from "./helpers/fakeAiProvider";
import {
  computeDuplicateCheckDisplayState,
  canTriggerDuplicateCheck,
  duplicateCheckAction,
  duplicateCheckButtonLabel,
} from "../lib/ai/duplicateCheckActionability";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

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
  const createdSourceItemIds: number[] = [];
  const createdClaimIds: number[] = [];

  /** One genuine succeeded extract_claims candidate -- (aiResultId, candidateIndex=0), with a real, parseable source item behind it. */
  async function createExtractionCandidate(statement: string): Promise<{ aiResultId: number; sourceItemId: number }> {
    const excerpt = `${statement} This is additional context around the statement.`;
    const [sourceItem] = await db
      .insert(sourceItems)
      .values({
        sourceId: SEEDED_SOURCE_ID,
        itemTypeId: SEEDED_ITEM_TYPE_ID,
        url: `https://example.test/pr6-orch-${randomUUID()}`,
        normalizedUrl: `https://example.test/pr6-orch-${randomUUID()}`,
        title: "PR6 orchestration fixture",
        excerpt,
      })
      .returning();
    createdSourceItemIds.push(sourceItem.id);

    const [job] = await db
      .insert(aiJobs)
      .values({ operation: "extract_claims", provider: "fake", model: "test-model", status: "succeeded", sourceItemId: sourceItem.id, completedAt: new Date() })
      .returning();
    const [result] = await db
      .insert(aiResults)
      .values({
        aiJobId: job.id,
        structuredOutput: {
          claims: [{ statement, informationType: "report", supportingExcerpt: statement, confidence: 0.9, reasoning: "fixture" }],
        },
      })
      .returning();

    return { aiResultId: result.id, sourceItemId: sourceItem.id };
  }

  async function createTestClaim(statement: string, projectId: number = DUPLICATE_CHECK_DEFAULT_PROJECT_ID): Promise<number> {
    const [row] = await db.insert(claims).values({ projectId, slug: `pr6-orch-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    createdClaimIds.push(row.id);
    return row.id;
  }

  async function countDetectDuplicatesJobs(aiResultId: number, candidateIndex: number): Promise<number> {
    const rows = await db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(and(eq(aiJobs.operation, "detect_duplicates"), eq(aiJobs.extractionAiResultId, aiResultId), eq(aiJobs.extractionCandidateIndex, candidateIndex)));
    return rows.length;
  }

  try {
    console.log("=== detect_duplicates orchestration (Phase 5 PR 6) -- fake provider only ===\n");

    // --- candidate not found -------------------------------------------
    {
      try {
        await triggerDetectDuplicates(999999999, 0, new FakeAiProvider([]));
        assert(false, "candidate not found: should have thrown");
      } catch (err) {
        assert(err instanceof DuplicateCheckCandidateNotFoundError, "candidate not found: throws DuplicateCheckCandidateNotFoundError");
      }
    }

    // --- reviewed (approved) candidate: zero jobs, zero provider calls --
    {
      const { aiResultId } = await createExtractionCandidate("The GTA VI map includes a swamp biome.");
      await approveClaimProposal({
        aiResultId,
        candidateIndex: 0,
        projectId: DUPLICATE_CHECK_DEFAULT_PROJECT_ID,
        statement: "The GTA VI map includes a swamp biome.",
        slug: `pr6-orch-approved-${randomUUID()}`,
        informationType: "report",
        topicIds: [],
        initialInvestigationStatus: "unverified",
        initialDevelopmentOutcome: "unknown",
        reason: "fixture approval",
      });

      const provider = new FakeAiProvider([]);
      try {
        await triggerDetectDuplicates(aiResultId, 0, provider);
        assert(false, "approved candidate: should have thrown");
      } catch (err) {
        assert(err instanceof ProposalAlreadyReviewedForDuplicateCheckError, "approved candidate: throws ProposalAlreadyReviewedForDuplicateCheckError");
      }
      assert(provider.receivedRequests.length === 0, "approved candidate: zero provider calls");
      assert((await countDetectDuplicatesJobs(aiResultId, 0)) === 0, "approved candidate: zero detect_duplicates ai_jobs rows");
    }

    // --- reviewed (rejected) candidate: zero jobs, zero provider calls --
    {
      const { aiResultId } = await createExtractionCandidate("The GTA VI map includes a desert biome.");
      await rejectClaimProposal({ aiResultId, candidateIndex: 0, notes: "fixture rejection" });

      const provider = new FakeAiProvider([]);
      try {
        await triggerDetectDuplicates(aiResultId, 0, provider);
        assert(false, "rejected candidate: should have thrown");
      } catch (err) {
        assert(err instanceof ProposalAlreadyReviewedForDuplicateCheckError, "rejected candidate: throws ProposalAlreadyReviewedForDuplicateCheckError");
      }
      assert(provider.receivedRequests.length === 0, "rejected candidate: zero provider calls");
      assert((await countDetectDuplicatesJobs(aiResultId, 0)) === 0, "rejected candidate: zero detect_duplicates ai_jobs rows");
    }

    // --- reviewed (link_existing_claim) candidate: zero jobs, zero provider calls --
    {
      const existingClaimId = await createTestClaim("GTA VI features a swamp region on the map.");
      const { aiResultId } = await createExtractionCandidate("The map has a swampy area.");

      // Seed a genuine succeeded detect_duplicates result so resolution has a real persisted match to reference.
      const [ddJob] = await db
        .insert(aiJobs)
        .values({
          operation: "detect_duplicates",
          provider: "fake",
          model: "test-model",
          status: "succeeded",
          extractionAiResultId: aiResultId,
          extractionCandidateIndex: 0,
          completedAt: new Date(),
        })
        .returning();
      await db.insert(aiResults).values({
        aiJobId: ddJob.id,
        structuredOutput: { matches: [{ existingClaimId, confidence: 0.9, reasoning: "fixture match" }] },
      });

      await resolveProposalAsExistingClaim({ aiResultId, candidateIndex: 0, existingClaimId, reason: "fixture resolution" });

      const provider = new FakeAiProvider([]);
      try {
        await triggerDetectDuplicates(aiResultId, 0, provider);
        assert(false, "link_existing_claim candidate: should have thrown");
      } catch (err) {
        assert(err instanceof ProposalAlreadyReviewedForDuplicateCheckError, "link_existing_claim candidate: throws ProposalAlreadyReviewedForDuplicateCheckError");
      }
      assert(provider.receivedRequests.length === 0, "link_existing_claim candidate: zero provider calls");

      // The prior succeeded check remains historical, queryable, untouched.
      const [preservedJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, ddJob.id));
      assert(preservedJob.status === "succeeded", "link_existing_claim candidate: the prior succeeded detect_duplicates job remains historical and untouched");
    }

    // --- zero existing claims: zero job rows, zero provider calls -------
    //
    // Deterministic, not a shared-database-state SKIP: creates a
    // genuinely isolated project with zero claims and passes its id
    // through triggerDetectDuplicates' injectable `projectId` parameter
    // -- the SAME testability seam getDuplicateCheckRetrievalSet exposes,
    // used ONLY here, never by any production/admin code path (which
    // always calls triggerDetectDuplicates with just two arguments, so
    // real traffic only ever resolves to DUPLICATE_CHECK_DEFAULT_PROJECT_ID).
    // This proves the core PR6 cost-control invariant -- zero existing
    // claims -> zero provider calls, zero new ai_jobs rows -- without
    // depending on the shared seeded database's project-1 claim count.
    {
      const [isolatedProject] = await db.insert(projects).values({ slug: `pr6-zero-claims-${randomUUID()}`, name: "PR6 zero-claims fixture project" }).returning();

      const { aiResultId } = await createExtractionCandidate("A candidate statement with genuinely zero existing claims to compare against.");
      const provider = new FakeAiProvider([]);
      const result = await triggerDetectDuplicates(aiResultId, 0, provider, isolatedProject.id);
      assert(result.kind === "no_existing_claims", "zero existing claims: triggerDetectDuplicates returns kind 'no_existing_claims'");
      assert(provider.receivedRequests.length === 0, "zero existing claims: zero provider calls");
      assert((await countDetectDuplicatesJobs(aiResultId, 0)) === 0, "zero existing claims: zero detect_duplicates ai_jobs rows");

      const retrievalSet = await getDuplicateCheckRetrievalSet("Any statement.", isolatedProject.id);
      assert(retrievalSet.length === 0, "zero existing claims: getDuplicateCheckRetrievalSet itself returns an empty array for the isolated project");
    }

    // --- small claim set: all claims supplied to the model --------------
    // Deterministic, isolated-project fixture -- same technique as the
    // zero-existing-claims case above -- rather than depending on the
    // shared seeded database's project-1 claim count staying below the
    // threshold.
    {
      const [smallSetProject] = await db.insert(projects).values({ slug: `pr6-small-set-${randomUUID()}`, name: "PR6 small-set fixture project" }).returning();
      for (let i = 0; i < 3; i++) await createTestClaim(`Small-set fixture claim ${i} ${randomUUID()}.`, smallSetProject.id);

      const set = await getDuplicateCheckRetrievalSet("A statement to check against the small set.", smallSetProject.id);
      assert(set.length === 3, `small claim set: retrieval set includes ALL 3 claims in the isolated project (got ${set.length})`);
    }

    // --- above threshold: bounded pg_trgm-ranked subset ------------------
    // Same isolated-project technique, sized deliberately past
    // DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD.
    {
      const [largeSetProject] = await db.insert(projects).values({ slug: `pr6-large-set-${randomUUID()}`, name: "PR6 large-set fixture project" }).returning();
      const totalToCreate = DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD + 5;
      for (let i = 0; i < totalToCreate; i++) {
        await createTestClaim(`Large-set fixture claim ${i} ${randomUUID()} about swamps, deserts, and cities.`, largeSetProject.id);
      }

      const set = await getDuplicateCheckRetrievalSet("A statement about swamps and cities to check against the large set.", largeSetProject.id);
      assert(set.length <= DUPLICATE_CHECK_PREFILTER_LIMIT, `above threshold: retrieval set is bounded to at most DUPLICATE_CHECK_PREFILTER_LIMIT (${DUPLICATE_CHECK_PREFILTER_LIMIT}), got ${set.length}`);
      assert(set.length > 0, "above threshold: retrieval set is non-empty");
    }

    // --- candidate-scoped in-flight concurrency race ---------------------
    {
      const { aiResultId } = await createExtractionCandidate("A concurrency-race fixture candidate statement.");
      const first = await createPendingAiJob({ operation: "detect_duplicates", provider: "fake", model: "test-model", extractionAiResultId: aiResultId, extractionCandidateIndex: 0 });
      const second = await createPendingAiJob({ operation: "detect_duplicates", provider: "fake", model: "test-model", extractionAiResultId: aiResultId, extractionCandidateIndex: 0 });
      assert(first.ok === true, "concurrency race: the first pending job is created");
      assert(second.ok === false && second.reason === "already_in_flight", "concurrency race: the second SIMULTANEOUS attempt for the SAME candidate is rejected as already_in_flight");
      assert((await countDetectDuplicatesJobs(aiResultId, 0)) === 1, "concurrency race: exactly one ai_jobs row exists for this candidate");
    }

    // --- six-state actionability -----------------------------------------
    {
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 6 * 60 * 1000);

      assert(computeDuplicateCheckDisplayState(false, null, now) === "no_existing_claims", "actionability: hasExistingClaims=false -> no_existing_claims");
      assert(computeDuplicateCheckDisplayState(true, null, now) === "not_checked", "actionability: no job, claims exist -> not_checked");
      assert(computeDuplicateCheckDisplayState(true, { status: "pending", createdAt: now, startedAt: null }, now) === "in_progress", "actionability: fresh pending job -> in_progress");
      assert(computeDuplicateCheckDisplayState(true, { status: "pending", createdAt: fiveMinAgo, startedAt: null }, now) === "stale", "actionability: old pending job -> stale");
      assert(computeDuplicateCheckDisplayState(true, { status: "failed", createdAt: now, startedAt: now }, now) === "failed", "actionability: failed job -> failed");
      assert(computeDuplicateCheckDisplayState(true, { status: "succeeded", createdAt: now, startedAt: now }, now) === "succeeded", "actionability: succeeded job -> succeeded");

      assert(canTriggerDuplicateCheck("not_checked") === true, "actionability: not_checked is actionable");
      assert(canTriggerDuplicateCheck("stale") === true, "actionability: stale is actionable");
      assert(canTriggerDuplicateCheck("failed") === true, "actionability: failed is actionable");
      assert(canTriggerDuplicateCheck("no_existing_claims") === false, "actionability: no_existing_claims is NOT actionable");
      assert(canTriggerDuplicateCheck("in_progress") === false, "actionability: in_progress is NOT actionable");
      assert(canTriggerDuplicateCheck("succeeded") === false, "actionability: succeeded is NOT actionable (no re-check offered)");

      assert(duplicateCheckAction("not_checked") === "check", "actionability: not_checked action is 'check'");
      assert(duplicateCheckAction("stale") === "recover", "actionability: stale action is 'recover'");
      assert(duplicateCheckAction("failed") === "retry", "actionability: failed action is 'retry'");
      assert(duplicateCheckAction("no_existing_claims") === null, "actionability: no_existing_claims has no action");
      assert(duplicateCheckAction("in_progress") === null, "actionability: in_progress has no action");
      assert(duplicateCheckAction("succeeded") === null, "actionability: succeeded has no action");

      assert(duplicateCheckButtonLabel("not_checked") === "Check duplicates", "actionability: not_checked label is 'Check duplicates'");
      assert(duplicateCheckButtonLabel("stale") === "Recover", "actionability: stale label is 'Recover'");
      assert(duplicateCheckButtonLabel("failed") === "Retry", "actionability: failed label is 'Retry'");
      assert(duplicateCheckButtonLabel("no_existing_claims") === null, "actionability: no_existing_claims has no label");
    }
  } finally {
    // Deliberately no incremental row cleanup here, matching
    // claimProposalReview.check.ts's own established convention for this
    // file: several cases above create claim_proposal_reviews/
    // admin_decisions rows (via approveClaimProposal/rejectClaimProposal/
    // resolveProposalAsExistingClaim) that FK-reference the ai_results
    // fixtures this file also creates, so deleting the latter without
    // also unwinding the former would violate those foreign keys. This
    // check database is expected to be recreated via a fresh migration
    // chain + reseed for a clean run (see README.md's verification
    // sequence), not incrementally cleaned by each check file.
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll detect_duplicates orchestration checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
