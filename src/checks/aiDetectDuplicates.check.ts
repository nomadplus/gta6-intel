/**
 * Regression check for Phase 5 PR 6's detectDuplicates operation
 * (src/lib/ai/operations/detectDuplicates.ts) at the OPERATION level --
 * exercises the real detectDuplicates() function (and, through it, the
 * real runAiOperation()) against a REAL local Postgres database, using
 * ONLY FakeAiProvider -- never a real Anthropic API call.
 *
 * Covers:
 *   - a valid single-match result persists correctly, linked via
 *     ai_jobs.extraction_ai_result_id/.extraction_candidate_index;
 *     ai_results.confidence/reasoning stay NULL
 *   - a FABRICATED existingClaimId (not one of the ids actually supplied
 *     to this call) is rejected as invalid_structured_output, with zero
 *     ai_results rows -- proving the runtime-grounding check, not just
 *     the prompt wording
 *   - matches: [] with a noLikelyDuplicateNote is a normal SUCCESS
 *   - noLikelyDuplicateNote present alongside a NON-empty matches array
 *     is rejected
 *   - duplicate existingClaimId values within one result are rejected
 *   - multiple distinct matches in one result are accepted
 *   - malformed output (confidence out of range) is rejected
 *   - the operation-specific output-token bound
 *     (DETECT_DUPLICATES_MAX_OUTPUT_TOKENS = 768) is actually forwarded
 *     to the provider request
 *   - kill switch / budget block: provider never invoked
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/aiDetectDuplicates.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { aiJobs, aiResults, claims, projects } from "../db/schema";
import { detectDuplicates, DETECT_DUPLICATES_MAX_OUTPUT_TOKENS, type DuplicateCandidateClaimForCheck } from "../lib/ai/operations/detectDuplicates";
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

const SEEDED_PROJECT_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: this check performs real writes and must never be pointed at a production database.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL is not set -- detectDuplicates writes via adminDb, same as every other admin mutation.");
  }
  if (!process.env.AI_DEFAULT_MODEL) {
    throw new Error("AI_DEFAULT_MODEL is not set -- required by runAiOperation() underneath detectDuplicates().");
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdClaimIds: number[] = [];
  const createdParentJobIds: number[] = [];

  async function createTestClaim(statement: string): Promise<{ id: number; statement: string }> {
    const [row] = await db.insert(claims).values({ projectId: SEEDED_PROJECT_ID, slug: `pr6-check-${randomUUID()}`, statement, informationType: "report" }).returning();
    createdClaimIds.push(row.id);
    return { id: row.id, statement: row.statement };
  }

  /**
   * detect_duplicates jobs carry a REAL foreign key to ai_results
   * (extraction_ai_result_id, migration 0018) -- unlike sourceItemId
   * (which merely needs to be plausible for other operations' checks),
   * this column is enforced by the database and rejects any id that
   * isn't a genuine ai_results row (confirmed by direct testing while
   * writing this migration). This helper creates one minimal, real
   * "parent" extract_claims-shaped ai_jobs + ai_results row per test
   * case, exactly so each case's extractionAiResultId is genuine.
   */
  async function createParentAiResult(): Promise<number> {
    const [job] = await db
      .insert(aiJobs)
      .values({ operation: "extract_claims", provider: "fake-parent", model: "fake-parent", status: "succeeded", completedAt: new Date() })
      .returning();
    createdParentJobIds.push(job.id);
    const [result] = await db
      .insert(aiResults)
      .values({ aiJobId: job.id, structuredOutput: { claims: [] } })
      .returning();
    return result.id;
  }

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  async function loadResultsForJob(jobId: number) {
    return db.select().from(aiResults).where(eq(aiResults.aiJobId, jobId));
  }

  try {
    const [projectRow] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, SEEDED_PROJECT_ID));
    if (!projectRow) throw new Error(`Seeded project #${SEEDED_PROJECT_ID} not found -- run npm run db:seed first.`);

    console.log("=== detectDuplicates operation (Phase 5 PR 6) -- fake provider only ===\n");

    // --- valid single-match success ------------------------------------
    {
      const existingClaim = await createTestClaim("GTA VI is set in a fictionalized version of Miami called Vice City.");
      const candidateClaims: DuplicateCandidateClaimForCheck[] = [existingClaim];
      const extractionAiResultId = await createParentAiResult();

      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            matches: [{ existingClaimId: existingClaim.id, confidence: 0.92, reasoning: "Same underlying setting fact, worded differently." }],
          },
          tokensIn: 80,
          tokensOut: 30,
        },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "GTA VI's setting is a fictional Miami called Vice City.",
        existingClaims: candidateClaims,
      });

      assert(result.ok === true, "valid single-match: detectDuplicates returns ok:true");
      if (result.ok) {
        assert(result.data.matches.length === 1, "valid single-match: one match returned");
        assert(result.data.matches[0].existingClaimId === existingClaim.id, "valid single-match: match references the correct existing claim");

        const job = await loadJob(result.jobId);
        assert(job.status === "succeeded", "valid single-match: job row status is 'succeeded'");
        assert(job.operation === "detect_duplicates", "valid single-match: job row operation is 'detect_duplicates'");
        assert(job.extractionAiResultId === extractionAiResultId, "valid single-match: job row linked via extraction_ai_result_id");
        assert(job.extractionCandidateIndex === 0, "valid single-match: job row linked via extraction_candidate_index");

        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 1, "valid single-match: exactly one ai_results row exists");
        assert(
          results[0].confidence === null && results[0].reasoning === null,
          "valid single-match: ai_results.confidence/reasoning stay NULL -- per-match values live only in structured_output"
        );
      }
    }

    // --- fabricated existingClaimId: rejected, zero ai_results ----------
    {
      const existingClaim = await createTestClaim("The GTA VI protagonist is named Lucia.");
      const extractionAiResultId = await createParentAiResult();

      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            // 999999 was never part of the supplied candidate set.
            matches: [{ existingClaimId: 999999, confidence: 0.8, reasoning: "fabricated for this check" }],
          },
          tokensIn: 40,
          tokensOut: 15,
        },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "GTA VI's protagonist is a woman named Lucia.",
        existingClaims: [existingClaim],
      });

      assert(result.ok === false, "fabricated existingClaimId: returns ok:false");
      if (!result.ok) {
        assert(result.reason === "invalid_structured_output", "fabricated existingClaimId: failure reason is 'invalid_structured_output'");
        if (result.jobId !== null) {
          const job = await loadJob(result.jobId);
          assert(job.status === "failed", "fabricated existingClaimId: job row status is 'failed'");
          const results = await loadResultsForJob(result.jobId);
          assert(results.length === 0, "fabricated existingClaimId: zero ai_results rows exist");
        }
      }
    }

    // --- zero-match ("no likely duplicate") success ---------------------
    {
      const existingClaim = await createTestClaim("GTA VI includes a female protagonist.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { matches: [], noLikelyDuplicateNote: "Distinct fact -- no genuine duplicate among supplied claims." }, tokensIn: 30, tokensOut: 10 },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "GTA VI will release on a Tuesday.",
        existingClaims: [existingClaim],
      });

      assert(result.ok === true, "zero-match: detectDuplicates returns ok:true -- this is a SUCCESS, not a failure");
      if (result.ok) {
        assert(result.data.matches.length === 0, "zero-match: structured output has an empty matches array");
        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 1, "zero-match: exactly one ai_results row exists (success is persisted normally)");
      }
    }

    // --- noLikelyDuplicateNote alongside non-empty matches: rejected ----
    {
      const existingClaim = await createTestClaim("GTA VI is developed by Rockstar North.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            matches: [{ existingClaimId: existingClaim.id, confidence: 0.7, reasoning: "test" }],
            noLikelyDuplicateNote: "should not co-occur with a non-empty matches array",
          },
          tokensIn: 30,
          tokensOut: 10,
        },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Rockstar North developed GTA VI.",
        existingClaims: [existingClaim],
      });
      assert(result.ok === false, "note-with-matches: rejected");
      if (!result.ok) assert(result.reason === "invalid_structured_output", "note-with-matches: failure reason is 'invalid_structured_output'");
    }

    // --- duplicate existingClaimId within one result: rejected -----------
    {
      const claimA = await createTestClaim("Claim A statement.");
      const claimB = await createTestClaim("Claim B statement.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            matches: [
              { existingClaimId: claimA.id, confidence: 0.6, reasoning: "first mention" },
              { existingClaimId: claimA.id, confidence: 0.7, reasoning: "duplicate mention of the same id" },
            ],
          },
          tokensIn: 30,
          tokensOut: 10,
        },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Candidate statement.",
        existingClaims: [claimA, claimB],
      });
      assert(result.ok === false, "duplicate existingClaimId: rejected");
      if (!result.ok) assert(result.reason === "invalid_structured_output", "duplicate existingClaimId: failure reason is 'invalid_structured_output'");
    }

    // --- multiple distinct matches: accepted -----------------------------
    {
      const claimA = await createTestClaim("The map includes a swamp region.");
      const claimB = await createTestClaim("The map includes wetlands.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            matches: [
              { existingClaimId: claimA.id, confidence: 0.85, reasoning: "same fact, swamp/wetlands synonym" },
              { existingClaimId: claimB.id, confidence: 0.6, reasoning: "weaker but plausible match" },
            ],
          },
          tokensIn: 50,
          tokensOut: 20,
        },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "The game world features wetland terrain.",
        existingClaims: [claimA, claimB],
      });
      assert(result.ok === true, "multiple matches: detectDuplicates returns ok:true");
      if (result.ok) assert(result.data.matches.length === 2, "multiple matches: both matches returned");
    }

    // --- malformed output (confidence out of range): rejected ------------
    {
      const existingClaim = await createTestClaim("Malformed-output test claim.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { matches: [{ existingClaimId: existingClaim.id, confidence: 1.5, reasoning: "out of range" }] }, tokensIn: 20, tokensOut: 10 },
      ]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Test candidate.",
        existingClaims: [existingClaim],
      });
      assert(result.ok === false, "malformed confidence: rejected");
      if (!result.ok) assert(result.reason === "invalid_structured_output", "malformed confidence: failure reason is 'invalid_structured_output'");
    }

    // --- explicit output-token cap is forwarded --------------------------
    {
      const existingClaim = await createTestClaim("Token-cap test claim.");
      const extractionAiResultId = await createParentAiResult();
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { matches: [] }, tokensIn: 10, tokensOut: 5 }]);
      await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Test candidate.",
        existingClaims: [existingClaim],
      });
      assert(provider.receivedRequests.length === 1, "token-cap: exactly one provider request was made");
      assert(
        provider.receivedRequests[0].maxOutputTokens === DETECT_DUPLICATES_MAX_OUTPUT_TOKENS,
        `token-cap: request.maxOutputTokens is exactly DETECT_DUPLICATES_MAX_OUTPUT_TOKENS (${DETECT_DUPLICATES_MAX_OUTPUT_TOKENS})`
      );
    }

    // --- kill switch: provider never invoked ------------------------------
    {
      const existingClaim = await createTestClaim("Kill-switch test claim.");
      const extractionAiResultId = await createParentAiResult();
      process.env.AI_KILL_SWITCH_ENGAGED = "true";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { matches: [] } }]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Test candidate.",
        existingClaims: [existingClaim],
      });
      delete process.env.AI_KILL_SWITCH_ENGAGED;
      assert(result.ok === false, "kill switch: returns ok:false");
      assert(provider.receivedRequests.length === 0, "kill switch: the provider was never invoked");
      if (!result.ok) assert(result.reason === "kill_switch_engaged", "kill switch: correct failure reason");
    }

    // --- budget block: provider never invoked -----------------------------
    {
      const existingClaim = await createTestClaim("Budget-block test claim.");
      const extractionAiResultId = await createParentAiResult();
      const previousBudget = process.env.AI_MONTHLY_BUDGET_USD;
      process.env.AI_MONTHLY_BUDGET_USD = "0";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { matches: [] } }]);
      const result = await detectDuplicates({
        provider,
        sourceItemId: 1,
        extractionAiResultId,
        extractionCandidateIndex: 0,
        candidateStatement: "Test candidate.",
        existingClaims: [existingClaim],
      });
      if (previousBudget === undefined) delete process.env.AI_MONTHLY_BUDGET_USD;
      else process.env.AI_MONTHLY_BUDGET_USD = previousBudget;
      assert(result.ok === false, "budget block: returns ok:false");
      assert(provider.receivedRequests.length === 0, "budget block: the provider was never invoked");
      if (!result.ok) assert(result.reason === "budget_exceeded", "budget block: correct failure reason");
    }
  } finally {
    // FK-safe order: for each parent extract_claims-shaped ai_results row
    // this check created, first delete any detect_duplicates ai_jobs/
    // ai_results rows that reference it via extraction_ai_result_id, then
    // the parent ai_results row itself, then its parent ai_jobs row.
    for (const parentJobId of createdParentJobIds) {
      const [parentResult] = await db.select({ id: aiResults.id }).from(aiResults).where(eq(aiResults.aiJobId, parentJobId));
      if (parentResult) {
        const childJobs = await db.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.extractionAiResultId, parentResult.id));
        for (const childJob of childJobs) {
          await db.delete(aiResults).where(eq(aiResults.aiJobId, childJob.id));
          await db.delete(aiJobs).where(eq(aiJobs.id, childJob.id));
        }
        await db.delete(aiResults).where(eq(aiResults.id, parentResult.id));
      }
      await db.delete(aiJobs).where(eq(aiJobs.id, parentJobId));
    }
    for (const id of createdClaimIds) {
      await db.delete(claims).where(eq(claims.id, id));
    }
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll detectDuplicates operation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
