/**
 * Regression check for Phase 5 PR 7's compare_claims orchestration:
 * the operation-level persistence (src/lib/ai/operations/compareClaims.ts,
 * exercised through the real runAiOperation()) AND the trigger-level
 * shortlist/eligibility logic
 * (src/lib/ai/operations/compareClaimsTrigger.ts), against a REAL local
 * Postgres database, using ONLY FakeAiProvider -- never a real Anthropic
 * API call.
 *
 * Covers:
 *   - the shortlist excludes the focus claim itself
 *   - the shortlist excludes claims already related in EITHER direction
 *   - the shortlist excludes claims in a DIFFERENT project
 *   - a small comparable set (<= COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD)
 *     sends every comparable claim
 *   - a comparable set above the threshold is capped to
 *     COMPARE_CLAIMS_MAX_CANDIDATES via pg_trgm ranking
 *   - zero comparable claims -> zero ai_jobs rows, zero provider calls,
 *     kind 'no_comparable_claims'
 *   - a valid multi-assessment result persists correctly, linked via
 *     ai_jobs.comparison_claim_id
 *   - a FABRICATED otherClaimId is rejected as invalid_structured_output,
 *     zero ai_results rows
 *   - the operation-specific output-token bound
 *     (COMPARE_CLAIMS_MAX_OUTPUT_TOKENS) is forwarded to the provider request
 *   - focus-claim-scoped in-flight concurrency race: two simultaneous
 *     attempts for the SAME focus claim, exactly one succeeds
 *   - ai_jobs_compare_claims_operation_consistency CHECK rejects a
 *     compare_claims job with NULL comparison_claim_id, and rejects a
 *     non-compare_claims job with comparison_claim_id populated
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/compareClaimsOrchestration.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and } from "drizzle-orm";
import { aiJobs, aiResults, claims, projects, claimRelationships } from "../db/schema";
import {
  triggerCompareClaims,
  getComparisonShortlist,
  ComparisonFocusClaimNotFoundError,
  COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD,
} from "../lib/ai/operations/compareClaimsTrigger";
import { compareClaims, COMPARE_CLAIMS_MAX_OUTPUT_TOKENS, COMPARE_CLAIMS_MAX_CANDIDATES } from "../lib/ai/operations/compareClaims";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { FakeAiProvider } from "./helpers/fakeAiProvider";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this check performs real database writes.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  if (!process.env.ADMIN_DATABASE_URL) throw new Error("ADMIN_DATABASE_URL is not set -- compareClaims writes via adminDb, same as every other admin mutation.");
  if (!process.env.AI_DEFAULT_MODEL) throw new Error("AI_DEFAULT_MODEL is not set -- required by runAiOperation() underneath compareClaims().");

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdProjectIds: number[] = [];

  async function createTestProject(): Promise<number> {
    const [row] = await db.insert(projects).values({ slug: `pr7-orch-project-${randomUUID()}`, name: "PR7 orchestration fixture project" }).returning();
    createdProjectIds.push(row.id);
    return row.id;
  }

  async function createTestClaim(projectId: number, statement: string): Promise<{ id: number; statement: string }> {
    const [row] = await db.insert(claims).values({ projectId, slug: `pr7-orch-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return { id: row.id, statement: row.statement };
  }

  async function countCompareClaimsJobs(claimId: number): Promise<number> {
    const rows = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.operation, "compare_claims"), eq(aiJobs.comparisonClaimId, claimId)));
    return rows.length;
  }

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  async function loadResultsForJob(jobId: number) {
    return db.select().from(aiResults).where(eq(aiResults.aiJobId, jobId));
  }

  try {
    console.log("=== compare_claims orchestration (Phase 5 PR 7) -- fake provider only ===\n");

    // --- focus claim not found --------------------------------------------
    {
      try {
        await triggerCompareClaims(999999999, new FakeAiProvider([]));
        assert(false, "focus claim not found: should have thrown");
      } catch (err) {
        assert(err instanceof ComparisonFocusClaimNotFoundError, "focus claim not found: throws ComparisonFocusClaimNotFoundError");
      }
    }

    // --- shortlist excludes self, other project, already-related pairs ---
    {
      const projectId = await createTestProject();
      const otherProjectId = await createTestProject();

      const focus = await createTestClaim(projectId, "The game features a swamp biome fixture claim.");
      const comparable1 = await createTestClaim(projectId, "The game features a desert biome fixture claim.");
      const comparable2 = await createTestClaim(projectId, "The game features an urban core fixture claim.");
      const alreadyRelatedA = await createTestClaim(projectId, "Already related to focus (as claim_id_a) fixture claim.");
      const alreadyRelatedB = await createTestClaim(projectId, "Already related to focus (as claim_id_b) fixture claim.");
      const otherProjectClaim = await createTestClaim(otherProjectId, "A claim in a completely different project.");

      // Focus already related to alreadyRelatedA with focus as claim_id_b (alreadyRelatedA.id < focus.id is not guaranteed, so insert both orientations explicitly).
      const [lowerA, higherA] = alreadyRelatedA.id < focus.id ? [alreadyRelatedA.id, focus.id] : [focus.id, alreadyRelatedA.id];
      await db.insert(claimRelationships).values({ claimIdA: lowerA, claimIdB: higherA, relationshipType: "related", createdBy: "human" });

      const [lowerB, higherB] = alreadyRelatedB.id < focus.id ? [alreadyRelatedB.id, focus.id] : [focus.id, alreadyRelatedB.id];
      await db.insert(claimRelationships).values({ claimIdA: lowerB, claimIdB: higherB, relationshipType: "equivalent", createdBy: "human" });

      const shortlist = await getComparisonShortlist(focus.id, projectId, focus.statement);
      const shortlistIds = new Set(shortlist.map((c) => c.id));

      assert(!shortlistIds.has(focus.id), "shortlist excludes the focus claim itself");
      assert(shortlistIds.has(comparable1.id), "shortlist includes an unrelated same-project claim");
      assert(shortlistIds.has(comparable2.id), "shortlist includes a second unrelated same-project claim");
      assert(!shortlistIds.has(alreadyRelatedA.id), "shortlist excludes a claim already related to the focus claim (focus stored as claim_id_b)");
      assert(!shortlistIds.has(alreadyRelatedB.id), "shortlist excludes a claim already related to the focus claim (focus stored as claim_id_a)");
      assert(!shortlistIds.has(otherProjectClaim.id), "shortlist excludes a claim in a DIFFERENT project entirely");
    }

    // --- small comparable set: every comparable claim is sent -------------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "Small-set fixture focus claim.");
      const expectedIds: number[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await createTestClaim(projectId, `Small-set fixture comparable claim ${i} ${randomUUID()}.`);
        expectedIds.push(c.id);
      }
      const shortlist = await getComparisonShortlist(focus.id, projectId, focus.statement);
      assert(shortlist.length === 3, `small comparable set: shortlist includes ALL 3 comparable claims (got ${shortlist.length})`);
      assert(expectedIds.every((id) => shortlist.some((c) => c.id === id)), "small comparable set: every expected claim id is present");
    }

    // --- above threshold: bounded pg_trgm-ranked subset -------------------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "A statement about swamps and cities for the large-set fixture.");
      const totalToCreate = COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD + 5;
      for (let i = 0; i < totalToCreate; i++) {
        await createTestClaim(projectId, `Large-set fixture claim ${i} ${randomUUID()} about swamps, deserts, and cities.`);
      }
      const shortlist = await getComparisonShortlist(focus.id, projectId, focus.statement);
      assert(
        shortlist.length <= COMPARE_CLAIMS_MAX_CANDIDATES,
        `above threshold: shortlist is bounded to at most COMPARE_CLAIMS_MAX_CANDIDATES (${COMPARE_CLAIMS_MAX_CANDIDATES}), got ${shortlist.length}`
      );
      assert(shortlist.length > 0, "above threshold: shortlist is non-empty");
    }

    // --- zero comparable claims: zero jobs, zero provider calls -----------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "A focus claim with genuinely zero comparable claims.");
      const provider = new FakeAiProvider([]);
      const result = await triggerCompareClaims(focus.id, provider);
      assert(result.kind === "no_comparable_claims", "zero comparable claims: triggerCompareClaims returns kind 'no_comparable_claims'");
      assert(provider.receivedRequests.length === 0, "zero comparable claims: zero provider calls");
      assert((await countCompareClaimsJobs(focus.id)) === 0, "zero comparable claims: zero compare_claims ai_jobs rows");
    }

    // --- valid multi-assessment success persists correctly ----------------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "GTA VI is set in a fictionalized version of Miami called Vice City.");
      const other1 = await createTestClaim(projectId, "The fictional city in GTA VI is named Vice City.");
      const other2 = await createTestClaim(projectId, "GTA VI features a swamp biome outside the main city.");

      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            assessments: [
              { otherClaimId: other1.id, relationshipType: "equivalent", confidence: 0.95, reasoning: "Same underlying setting fact." },
              { otherClaimId: other2.id, relationshipType: "related", confidence: 0.6, reasoning: "Both describe world/setting details." },
            ],
          },
          tokensIn: 90,
          tokensOut: 40,
        },
      ]);

      const result = await compareClaims({
        provider,
        focusClaim: { id: focus.id, statement: focus.statement },
        candidateClaims: [
          { id: other1.id, statement: other1.statement },
          { id: other2.id, statement: other2.statement },
        ],
      });

      assert(result.ok === true, "valid success: runAiOperation reports ok:true");
      if (result.ok) {
        const job = await loadJob(result.jobId);
        assert(job.status === "succeeded", "valid success: job status is 'succeeded'");
        assert(job.comparisonClaimId === focus.id, "valid success: ai_jobs.comparison_claim_id is the focus claim's id");
        assert(job.tokensIn === 90 && job.tokensOut === 40, "valid success: token counts persisted");
        assert(job.costEstimateUsd !== null, "valid success: a non-null cost estimate is persisted");

        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 1, "valid success: exactly one ai_results row");
        assert(results[0].confidence === null && results[0].reasoning === null, "valid success: ai_results.confidence/reasoning stay NULL at the top level (per-assessment values live inside structured_output)");
      }

      // --- fabricated otherClaimId rejected at the operation level --------
      const badProvider = new FakeAiProvider([
        { kind: "success", rawOutput: { assessments: [{ otherClaimId: 999999999, relationshipType: "related", confidence: 0.5, reasoning: "fabricated" }] } },
      ]);
      const badResult = await compareClaims({
        provider: badProvider,
        focusClaim: { id: focus.id, statement: focus.statement },
        candidateClaims: [{ id: other1.id, statement: other1.statement }],
      });
      assert(badResult.ok === false, "fabricated otherClaimId: runAiOperation reports ok:false");
      if (!badResult.ok) {
        assert(badResult.reason === "invalid_structured_output", "fabricated otherClaimId: reason is invalid_structured_output");
        assert(badResult.jobId !== null, "fabricated otherClaimId: a job row WAS created (this failure reaches the provider, unlike a safety block)");
        if (badResult.jobId !== null) {
          const badJob = await loadJob(badResult.jobId);
          assert(badJob.status === "failed", "fabricated otherClaimId: job status is 'failed'");
          const badResults = await loadResultsForJob(badResult.jobId);
          assert(badResults.length === 0, "fabricated otherClaimId: zero ai_results rows");
        }
      }
    }

    // --- output-token bound is forwarded to the provider request -----------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "Token-bound fixture focus claim.");
      const other = await createTestClaim(projectId, "Token-bound fixture other claim.");
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { assessments: [] }, tokensIn: 5, tokensOut: 5 }]);
      await compareClaims({ provider, focusClaim: { id: focus.id, statement: focus.statement }, candidateClaims: [{ id: other.id, statement: other.statement }] });
      assert(provider.receivedRequests.length === 1, "token bound: exactly one provider request was made");
      assert(
        provider.receivedRequests[0].maxOutputTokens === COMPARE_CLAIMS_MAX_OUTPUT_TOKENS,
        `token bound: the request's maxOutputTokens is COMPARE_CLAIMS_MAX_OUTPUT_TOKENS (${COMPARE_CLAIMS_MAX_OUTPUT_TOKENS}), got ${provider.receivedRequests[0].maxOutputTokens}`
      );
    }

    // --- focus-claim-scoped in-flight concurrency race ----------------------
    {
      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "Concurrency-race fixture focus claim.");
      const first = await createPendingAiJob({ operation: "compare_claims", provider: "fake", model: "test-model", comparisonClaimId: focus.id });
      const second = await createPendingAiJob({ operation: "compare_claims", provider: "fake", model: "test-model", comparisonClaimId: focus.id });
      assert(first.ok === true, "concurrency race: the first pending job is created");
      assert(second.ok === false && second.reason === "already_in_flight", "concurrency race: the second SIMULTANEOUS attempt for the SAME focus claim is rejected as already_in_flight");
      assert((await countCompareClaimsJobs(focus.id)) === 1, "concurrency race: exactly one ai_jobs row exists for this focus claim");
    }

    // --- ai_jobs_compare_claims_operation_consistency CHECK -----------------
    {
      let rejectedNullComparisonClaimId = false;
      try {
        await db.insert(aiJobs).values({ operation: "compare_claims", provider: "fake", model: "test-model", status: "pending", comparisonClaimId: null });
      } catch {
        rejectedNullComparisonClaimId = true;
      }
      assert(rejectedNullComparisonClaimId, "CHECK constraint: a compare_claims job with NULL comparison_claim_id is rejected by the database");

      const projectId = await createTestProject();
      const focus = await createTestClaim(projectId, "CHECK-constraint fixture claim.");
      let rejectedPopulatedOnOtherOperation = false;
      try {
        await db.insert(aiJobs).values({ operation: "classify_relevance", provider: "fake", model: "test-model", status: "pending", comparisonClaimId: focus.id });
      } catch {
        rejectedPopulatedOnOtherOperation = true;
      }
      assert(
        rejectedPopulatedOnOtherOperation,
        "CHECK constraint: a NON-compare_claims job with comparison_claim_id populated is rejected by the database"
      );
    }
  } finally {
    // Deliberately no incremental row cleanup here, matching
    // detectDuplicatesOrchestration.check.ts's/claimProposalReview.check.ts's
    // own established convention: this check database is expected to be
    // recreated via a fresh migration chain + reseed for a clean run (see
    // README.md's verification sequence), not incrementally cleaned by
    // each check file.
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll compare_claims orchestration checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
