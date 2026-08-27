/**
 * Regression check for Phase 5 PR 1's generic AI execution primitive:
 * runAiOperation (src/lib/ai/runAiOperation.ts) end to end against a
 * REAL local Postgres database, using ONLY FakeAiProvider
 * (src/checks/helpers/fakeAiProvider.ts) -- never a real Anthropic API
 * call. This check must remain deterministic, offline-capable (apart
 * from its local database), zero-cost, and safe to run repeatedly in
 * CI. A real-provider smoke test is a SEPARATE, explicitly-opted-in
 * command -- see src/checks/aiAnthropicLive.check.ts -- and is never
 * part of `npm run check`.
 *
 * Covers:
 *   - happy path: job ends 'succeeded', exactly one ai_results row,
 *     tokens/structured output/claimId all persisted
 *   - architectural boundary: a structured output that happens to
 *     contain fields literally named 'confidence'/'reasoning' must stay
 *     inside structured_output only -- it must NOT auto-populate the
 *     dedicated ai_results.confidence/ai_results.reasoning columns
 *   - explicit metadata passthrough: confidence/reasoning populate those
 *     dedicated columns ONLY when the caller supplies them explicitly
 *     (the same opaque-passthrough mechanism as claimId), independent of
 *     whatever the structured output itself contains
 *   - malformed structured output: job ends 'failed', ZERO ai_results rows
 *   - provider_error: job ends 'failed', zero ai_results rows
 *   - an unexpected throw from provider.complete() is still caught and
 *     produces a terminal 'failed' job (runAiOperation's own defensive
 *     try/catch, not something FakeAiProvider provides for free)
 *   - provider interchangeability: two differently-named FakeAiProvider
 *     instances both flow through the identical runAiOperation() code
 *     path, and ai_jobs.provider persists whichever name was actually
 *     supplied -- proving nothing here is hardcoded to one provider
 *   - explicit per-call model override vs AI_DEFAULT_MODEL fallback
 *
 * This exercises the REAL orchestrator and REAL mutation functions, not
 * a reimplementation. runAiOperation.ts and src/db/mutations/aiJobs.ts
 * are both "server-only"-guarded, so this must run with
 * `--conditions=react-server`, same as ingestionProcessor.check.ts.
 *
 * Run with: npx tsx --conditions=react-server src/checks/aiRunOperation.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { aiJobs, aiResults } from "../db/schema";
import { runAiOperation } from "../lib/ai/runAiOperation";
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

// A deliberately trivial operation-shaped schema -- PR1 owns no real
// operation, so this stands in for whatever a future PR3+ operation
// will define for real.
const exampleOutputSchema = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: this check performs real writes against ai_jobs/ai_results and must never be pointed at a production database.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL is not set -- runAiOperation writes via adminDb, same as every other admin mutation.");
  }
  if (!process.env.AI_DEFAULT_MODEL) {
    throw new Error("AI_DEFAULT_MODEL is not set -- required for the default-model-resolution case below.");
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdJobIds: number[] = [];

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  async function loadResultsForJob(jobId: number) {
    return db.select().from(aiResults).where(eq(aiResults.aiJobId, jobId));
  }

  try {
    console.log("=== runAiOperation (Phase 5 PR 1) -- fake provider only ===\n");

    // --- Happy path: structured output happens to contain fields named
    // 'confidence'/'reasoning' -- must stay inside structured_output only,
    // and must NOT auto-populate ai_results.confidence / ai_results.reasoning ---
    {
      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { summary: "female protagonist confirmed", confidence: 0.87, reasoning: "trailer 1" }, tokensIn: 500, tokensOut: 80 },
      ]);
      const result = await runAiOperation({
        operation: "recommend_status",
        provider,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
        inputRef: "check:happy-path",
        claimId: 1,
        // Deliberately NOT passing confidence/reasoning here -- this is
        // the architectural boundary under test: the operation's OWN
        // output happens to contain same-named fields, but that must
        // never leak into the dedicated ai_results columns on its own.
      });
      assert(result.ok === true, "happy path returns ok:true");
      if (result.ok) {
        createdJobIds.push(result.jobId);
        assert(result.data.summary === "female protagonist confirmed", "returned data matches the validated structured output");
        assert(result.tokensIn === 500 && result.tokensOut === 80, "returned token counts match what the provider reported");

        const job = await loadJob(result.jobId);
        assert(job.status === "succeeded", `job row status is 'succeeded' (got ${job.status})`);
        assert(job.provider === "fake", `job row provider is 'fake' (got ${job.provider})`);
        assert(job.model === process.env.AI_DEFAULT_MODEL, "job row model falls back to AI_DEFAULT_MODEL when no override is supplied");
        assert(job.tokensIn === 500 && job.tokensOut === 80, "job row persists token counts");
        assert(job.inputRef === "check:happy-path", "job row persists inputRef verbatim");
        assert(job.completedAt !== null, "job row has completedAt set");
        assert(job.error === null, "job row has no error on success");

        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 1, `exactly one ai_results row exists for a succeeded job (got ${results.length})`);
        const [resultRow] = results;
        const structuredOutput = resultRow.structuredOutput as { summary: string; confidence?: number; reasoning?: string };
        assert(structuredOutput.summary === "female protagonist confirmed", "ai_results.structured_output persists the validated data");
        assert(structuredOutput.confidence === 0.87, `the operation's own 'confidence' field remains intact inside structured_output (got ${structuredOutput.confidence})`);
        assert(structuredOutput.reasoning === "trailer 1", `the operation's own 'reasoning' field remains intact inside structured_output (got ${structuredOutput.reasoning})`);
        assert(resultRow.confidence === null, `ARCHITECTURAL BOUNDARY: a same-named 'confidence' key inside structured output must NOT auto-populate ai_results.confidence (got ${resultRow.confidence})`);
        assert(resultRow.reasoning === null, `ARCHITECTURAL BOUNDARY: a same-named 'reasoning' key inside structured output must NOT auto-populate ai_results.reasoning (got ${resultRow.reasoning})`);
        assert(resultRow.claimId === 1, "claimId passed into runAiOperation is persisted onto ai_results");
      }
    }

    // --- Explicit metadata passthrough: confidence/reasoning populate the
    // dedicated columns ONLY when the caller explicitly supplies them,
    // via the same opaque-passthrough mechanism as claimId -- never
    // inferred from the structured output itself ---
    {
      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { summary: "explicit metadata case", confidence: 0.99 }, tokensIn: 10, tokensOut: 5 },
      ]);
      const result = await runAiOperation({
        operation: "recommend_status",
        provider,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
        confidence: 0.42, // deliberately different from the structured output's own 0.99, to prove independence
        reasoning: "explicit passthrough, not derived from structured output",
      });
      assert(result.ok === true, "explicit-metadata call returns ok:true");
      if (result.ok) {
        createdJobIds.push(result.jobId);
        const results = await loadResultsForJob(result.jobId);
        const [resultRow] = results;
        const structuredOutput = resultRow.structuredOutput as { confidence?: number };
        assert(resultRow.confidence === "0.420", `an explicitly supplied confidence populates ai_results.confidence (got ${resultRow.confidence})`);
        assert(resultRow.reasoning === "explicit passthrough, not derived from structured output", `an explicitly supplied reasoning populates ai_results.reasoning (got ${resultRow.reasoning})`);
        assert(structuredOutput.confidence === 0.99, `structured_output's own 'confidence' field is untouched and independent of the explicit metadata value (got ${structuredOutput.confidence})`);
      }
    }

    // --- Explicit model override -----------------------------------------
    {
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "x" }, tokensIn: 10, tokensOut: 5 }]);
      const result = await runAiOperation({
        operation: "embed",
        provider,
        model: "claude-haiku-4-5-20251001",
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === true, "explicit-model call returns ok:true");
      if (result.ok) {
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(job.model === "claude-haiku-4-5-20251001", `an explicit per-call model overrides AI_DEFAULT_MODEL (got ${job.model})`);
      }
    }

    // --- Malformed structured output --------------------------------------
    {
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: 12345 }, tokensIn: 200, tokensOut: 30 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "malformed structured output returns ok:false");
      if (!result.ok) {
        assert(result.jobId !== null, "a job row IS created for this failure reason (not already_in_flight)");
        if (result.jobId !== null) {
          createdJobIds.push(result.jobId);
          assert(result.reason === "invalid_structured_output", `failure reason is 'invalid_structured_output' (got ${result.reason})`);
          const job = await loadJob(result.jobId);
          assert(job.status === "failed", "job row status is 'failed' on malformed output");
          assert(job.error !== null && job.error.startsWith("invalid_structured_output:"), `job row error is prefixed with the failure reason (got ${job.error})`);
          assert(job.tokensIn === 200 && job.tokensOut === 30, "token counts the provider DID report before failing validation are still persisted");
          const results = await loadResultsForJob(result.jobId);
          assert(results.length === 0, `zero ai_results rows exist for a failed job (got ${results.length})`);
        }
      }
    }

    // --- Provider-reported error -------------------------------------------
    {
      const provider = new FakeAiProvider([{ kind: "provider_error", message: "upstream 500" }]);
      const result = await runAiOperation({
        operation: "evaluate_evidence",
        provider,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "provider_error returns ok:false");
      if (!result.ok) {
        assert(result.jobId !== null, "a job row IS created for this failure reason (not already_in_flight)");
        if (result.jobId !== null) {
          createdJobIds.push(result.jobId);
          assert(result.reason === "provider_error", `failure reason is 'provider_error' (got ${result.reason})`);
          const job = await loadJob(result.jobId);
          assert(job.status === "failed", "job row status is 'failed' on a provider error");
          const results = await loadResultsForJob(result.jobId);
          assert(results.length === 0, "zero ai_results rows exist for a provider-error job");
        }
      }
    }

    // --- Unexpected throw from provider.complete() --------------------------
    {
      const provider = new FakeAiProvider([{ kind: "throw", error: new Error("network socket reset") }]);
      const result = await runAiOperation({
        operation: "analyse_provenance",
        provider,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "an unexpected throw from the provider is still caught, not propagated");
      if (!result.ok) {
        assert(result.jobId !== null, "a job row IS created for this failure reason (not already_in_flight)");
        if (result.jobId !== null) {
          createdJobIds.push(result.jobId);
          assert(result.reason === "provider_error", "an unexpected throw is treated as provider_error");
          assert(result.message.includes("network socket reset"), "the original error message is preserved");
          const job = await loadJob(result.jobId);
          assert(job.status === "failed", "job row still reaches a terminal 'failed' state despite the throw -- no job is left stuck in 'running'");
        }
      }
    }

    // --- Provider interchangeability -----------------------------------------
    // NOTE (Phase 5 PR 6): this block originally used "detect_duplicates"
    // as its example operation, purely as an arbitrary still-valid enum
    // value (it was the newest one when this check was written for PR1)
    // -- it was never testing detect_duplicates' own business logic.
    // Migration 0018 added ai_jobs_detect_duplicates_operation_consistency,
    // a CHECK requiring extraction_ai_result_id/extraction_candidate_index
    // whenever operation = 'detect_duplicates' -- a real, intentional PR6
    // constraint for that operation's own candidate-scoped identity, not
    // something this generic, operation-agnostic provider-interchangeability
    // check should have to satisfy. Swapped to "compare_claims" -- at the
    // time, the one remaining enum value with no operation-specific
    // constraints and not already used by another block in this same
    // file -- to preserve this test's actual, unrelated intent
    // (provider-agnostic behavior) without fighting a constraint that has
    // nothing to do with what it verifies.
    //
    // NOTE (Phase 5 PR 7): swapped AGAIN, from "compare_claims" to
    // "embed". Migration 0021 added
    // ai_jobs_compare_claims_operation_consistency, requiring
    // comparison_claim_id whenever operation = 'compare_claims' -- a
    // real PR7 constraint for THAT operation's own focus-claim-scoped
    // identity, and (per the identical reasoning immediately above)
    // nothing this generic block should have to satisfy either. The
    // original "the one remaining enum value with no operation-specific
    // constraints AND not already used by another block in this same
    // file" selection criterion is no longer satisfiable: every one of
    // the eight ai_operation enum values now appears somewhere else in
    // this file (recommend_status, embed, classify_relevance,
    // evaluate_evidence, analyse_provenance are each used by their own
    // dedicated blocks elsewhere here; extract_claims/detect_duplicates/
    // compare_claims all carry operation-specific constraints).
    // Verified directly against schema.ts and every migration file
    // before choosing "embed": it appears ONLY in the ai_operation enum
    // definition itself (migration 0000), with no CHECK, unique index,
    // or FK column anywhere conditioned on it -- unlike
    // analyse_provenance/evaluate_evidence/recommend_status, which are
    // exactly Phase 5 PR8's upcoming operations and would risk forcing
    // this same swap again within a single following PR. Reuse of the
    // same enum value across two independent blocks within this one file
    // is harmless -- each block creates its own independent job rows,
    // and this generic assertion has never been about any one
    // operation's own business logic. If "embed" ever gains an
    // operation-specific constraint, this fixture must move again -- and
    // the pool of truly unconstrained values is shrinking.
    {
      const providerA = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "a" }, tokensIn: 1, tokensOut: 1 }], "provider-a");
      const providerB = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "b" }, tokensIn: 1, tokensOut: 1 }], "provider-b");

      const resultA = await runAiOperation({
        operation: "embed",
        provider: providerA,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      const resultB = await runAiOperation({
        operation: "embed",
        provider: providerB,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });

      assert(resultA.ok === true && resultB.ok === true, "both differently-named providers succeed through the identical runAiOperation() call");
      if (resultA.ok && resultB.ok) {
        createdJobIds.push(resultA.jobId, resultB.jobId);
        const jobA = await loadJob(resultA.jobId);
        const jobB = await loadJob(resultB.jobId);
        assert(jobA.provider === "provider-a", `runAiOperation persists whichever provider.name it was given, not a hardcoded value (got ${jobA.provider})`);
        assert(jobB.provider === "provider-b", `a second, differently-named provider persists its own name too (got ${jobB.provider})`);
        assert(jobA.operation === "embed" && jobB.operation === "embed", "the embed enum value is accepted by ai_jobs.operation");
      }
    }

    console.log(failures === 0 ? "\nAll runAiOperation checks passed." : `\n${failures} check(s) FAILED.`);
  } finally {
    // Clean up in reverse dependency order: ai_results rows are removed
    // by cascading through aiJobId's ON DELETE behavior implicitly? No --
    // there is no ON DELETE CASCADE on ai_results.ai_job_id (see
    // schema.ts), so results must be deleted before their parent job.
    if (createdJobIds.length > 0) {
      for (const jobId of createdJobIds) {
        await db.delete(aiResults).where(eq(aiResults.aiJobId, jobId));
      }
      for (const jobId of createdJobIds) {
        await db.delete(aiJobs).where(eq(aiJobs.id, jobId));
      }
    }
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
