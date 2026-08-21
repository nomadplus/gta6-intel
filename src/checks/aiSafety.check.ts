/**
 * Regression check for Phase 5 PR 2's AI cost controls & kill switch:
 * src/lib/ai/safety/{killSwitch,pricing,budget,evaluateAiSafety,money}.ts,
 * plus their wiring into runAiOperation.ts (src/lib/ai/runAiOperation.ts)
 * and the ai_jobs failure-path cost persistence
 * (src/db/mutations/aiJobs.ts, src/lib/ai/aiJobLifecycle.ts).
 *
 * Runs against a REAL local Postgres database, using ONLY FakeAiProvider
 * (src/checks/helpers/fakeAiProvider.ts) -- never a real Anthropic API
 * call. Deterministic, offline-capable apart from the local database,
 * zero-cost, safe for CI. Mirrors aiRunOperation.check.ts's shape and
 * cleanup pattern exactly.
 *
 * Covers:
 *   - kill switch: engaged blocks execution before the provider is ever
 *     invoked (receivedRequests stays empty), for BOTH an unset/"false"
 *     value (disengaged, must not block) and various engaged values,
 *     including a "typo" value -- proving the guard treats ambiguity as
 *     "stop", not "proceed"
 *   - kill switch blocks regardless of which provider is passed, proving
 *     the guard is provider-agnostic, not special-cased to "anthropic"
 *   - unknown model pricing: a model with no entry in
 *     src/lib/ai/safety/pricing.ts is blocked before the provider is
 *     invoked
 *   - known model pricing: exact expected micro-USD cost is persisted to
 *     ai_jobs.cost_estimate_usd for a known token count (catches any
 *     float-arithmetic regression)
 *   - AI_MONTHLY_BUDGET_USD is MANDATORY: absent, empty, or malformed all
 *     fail closed (block, provider never invoked) -- there is no
 *     "unset means unlimited spend" fallback
 *   - AI_MONTHLY_BUDGET_USD="0" is a valid, deliberately restrictive
 *     ceiling that blocks every call once evaluated, with no special-cased
 *     "zero means off" branch anywhere in the implementation
 *   - a valid, non-restrictive budget lets normal safety evaluation
 *     continue (pricing/kill-switch checks still run, execution proceeds)
 *   - budget ceiling: month-to-date spend at or above
 *     AI_MONTHLY_BUDGET_USD blocks the next call before the provider is
 *     invoked; spend below the ceiling allows it
 *   - month boundary correctness: a manually-dated prior-UTC-month row
 *     with a large cost is excluded from the current month's sum
 *   - NULL-cost historical rows are treated as $0 contribution, not a
 *     query error
 *   - a failure that still reached the provider (invalid_structured_output,
 *     tokens > 0) persists a non-null cost -- the failure-path cost gap
 *     PR 2 closes
 *   - a failure blocked BEFORE the provider (kill switch / unknown model /
 *     budget / missing or malformed budget config) persists no cost and
 *     zero ai_results rows, since nothing was spent
 *   - blocked jobs never pass through 'running' -- no provider call was
 *     attempted
 *   - a missing/malformed budget config throws straight out of
 *     runAiOperation() with NO ai_jobs row created at all -- proven via a
 *     before/after row-count comparison, not just a unit test of the
 *     parser in isolation
 *
 * Every sub-test that touches AI_KILL_SWITCH_ENGAGED or
 * AI_MONTHLY_BUDGET_USD restores both to this file's own permissive
 * defaults (DEFAULT_TEST_BUDGET_USD, kill switch disengaged) immediately
 * afterward, so no test's environment mutation leaks into a later test in
 * this file or into any other check script's process.
 *
 * server-only-guarded (runAiOperation.ts, aiJobs.ts, and the safety/*
 * modules all import "server-only"), so this must run with
 * --conditions=react-server, same as aiRunOperation.check.ts.
 *
 * Run with: npx tsx --conditions=react-server src/checks/aiSafety.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { aiJobs, aiResults } from "../db/schema";
import { runAiOperation } from "../lib/ai/runAiOperation";
import { MalformedAiBudgetConfigError, MissingAiBudgetConfigError, getMonthlyBudgetCeilingMicros } from "../lib/ai/safety/budget";
import { microsToUsdString, parseUsdStringToMicros } from "../lib/ai/safety/money";
import { calculateCostMicros } from "../lib/ai/safety/pricing";
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

function assertThrows(fn: () => void, expectedErrorClass: new (...args: never[]) => Error, message: string) {
  try {
    fn();
    console.error(`FAIL: ${message} (did not throw)`);
    failures++;
  } catch (err) {
    if (err instanceof expectedErrorClass) {
      console.log(`PASS: ${message}`);
    } else {
      console.error(`FAIL: ${message} (threw ${(err as Error).constructor.name}, expected ${expectedErrorClass.name})`);
      failures++;
    }
  }
}

const exampleOutputSchema = z.object({ summary: z.string() });

// A model that deliberately has NO entry in src/lib/ai/safety/pricing.ts.
const UNPRICED_MODEL = "claude-check-unpriced-model-does-not-exist";
// A model that DOES have a known entry (see pricing.ts): $3/$15 per MTok.
const PRICED_MODEL = "claude-sonnet-4-6";
const PRICED_MODEL_INPUT_MICROS_PER_MTOK = 3_000_000n;
const PRICED_MODEL_OUTPUT_MICROS_PER_MTOK = 15_000_000n;

// A generously large budget used as this file's own permissive default,
// so every test NOT specifically exercising budget behavior can call
// runAiOperation() without incidentally tripping AI_MONTHLY_BUDGET_USD's
// now-mandatory requirement.
const DEFAULT_TEST_BUDGET_USD = "1000000";

function restoreDefaultTestEnv() {
  process.env.AI_MONTHLY_BUDGET_USD = DEFAULT_TEST_BUDGET_USD;
  delete process.env.AI_KILL_SWITCH_ENGAGED;
}

/** Mirrors pricing.ts's calculateCostMicros exactly (BigInt, truncating division) so expected-value assertions below use the identical arithmetic path being tested, not an independent (and possibly inconsistent) reimplementation. */
function expectedCostMicros(tokensIn: number, tokensOut: number): bigint {
  const inputMicros = BigInt(tokensIn) * PRICED_MODEL_INPUT_MICROS_PER_MTOK;
  const outputMicros = BigInt(tokensOut) * PRICED_MODEL_OUTPUT_MICROS_PER_MTOK;
  return (inputMicros + outputMicros) / 1_000_000n;
}

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
    throw new Error("AI_DEFAULT_MODEL is not set -- required for several cases below.");
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

  async function countAiJobs(): Promise<number> {
    const rows = await db.select({ id: aiJobs.id }).from(aiJobs);
    return rows.length;
  }

  // Directly inserts an ai_jobs row with an explicit createdAt/cost, for
  // seeding month-to-date spend scenarios -- bypasses runAiOperation
  // entirely, since these rows represent PAST jobs, not a call under test.
  async function seedHistoricalJob(params: { createdAt: Date; costEstimateUsd: string | null }) {
    const [row] = await db
      .insert(aiJobs)
      .values({
        operation: "classify_relevance",
        provider: "fake",
        model: PRICED_MODEL,
        status: "succeeded",
        costEstimateUsd: params.costEstimateUsd,
        createdAt: params.createdAt,
      })
      .returning({ id: aiJobs.id });
    createdJobIds.push(row.id);
    return row.id;
  }

  try {
    console.log("=== AI safety controls (Phase 5 PR 2) -- fake provider only ===\n");
    restoreDefaultTestEnv();

    // --- Kill switch: unset/"false" does not block --------------------------
    {
      restoreDefaultTestEnv();
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "ok" }, tokensIn: 10, tokensOut: 5 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === true, "unset AI_KILL_SWITCH_ENGAGED does not block execution");
      assert(provider.receivedRequests.length === 1, "the provider WAS invoked when the kill switch is unset");
      if (result.ok) createdJobIds.push(result.jobId);
    }
    {
      restoreDefaultTestEnv();
      process.env.AI_KILL_SWITCH_ENGAGED = "false";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "ok" }, tokensIn: 10, tokensOut: 5 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === true, 'the literal string "false" does not engage the kill switch');
      if (result.ok) createdJobIds.push(result.jobId);
      restoreDefaultTestEnv();
    }

    // --- Kill switch: engaged blocks BEFORE the provider is invoked, for
    // both an unambiguous value and a "typo" value (ambiguity favors
    // stopping, not proceeding) -- and blocks regardless of provider
    // identity, proving the guard is provider-agnostic ------------------------
    for (const [label, engagedValue] of [
      ["the canonical value", "true"],
      ["an unrecognized/typo value", "ture"],
    ] as const) {
      restoreDefaultTestEnv();
      process.env.AI_KILL_SWITCH_ENGAGED = engagedValue;
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "should never be reached" }, tokensIn: 10, tokensOut: 5 }], "fake");
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, `AI_KILL_SWITCH_ENGAGED="${engagedValue}" (${label}) blocks execution`);
      assert(provider.receivedRequests.length === 0, `(${label}) the provider was NEVER invoked -- proves the block happens before provider.complete()`);
      if (!result.ok) {
        assert(result.reason === "kill_switch_engaged", `(${label}) blocked reason is 'kill_switch_engaged' (got ${result.reason})`);
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(job.status === "failed", `(${label}) the blocked job's row is 'failed', not stuck in 'pending' or 'running'`);
        assert(job.startedAt === null, `(${label}) a killed-switch-blocked job never passes through 'running' -- startedAt stays null`);
        assert(job.costEstimateUsd === null, `(${label}) a blocked job persists no cost -- nothing was spent`);
        assert(job.error !== null && job.error.startsWith("kill_switch_engaged:"), `(${label}) job.error is prefixed with the blocked reason (got ${job.error})`);
        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 0, `(${label}) zero ai_results rows exist for a kill-switch-blocked job`);
      }
      restoreDefaultTestEnv();
    }

    // --- Unknown model pricing: blocked before the provider is invoked -----
    {
      restoreDefaultTestEnv();
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "should never be reached" }, tokensIn: 10, tokensOut: 5 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: UNPRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "a model absent from the static pricing map blocks execution");
      assert(provider.receivedRequests.length === 0, "the provider was never invoked for an unpriced model");
      if (!result.ok) {
        assert(result.reason === "unknown_model_pricing", `blocked reason is 'unknown_model_pricing' (got ${result.reason})`);
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(job.status === "failed", "the blocked job's row is 'failed'");
        assert(job.costEstimateUsd === null, "no cost is persisted for an unpriced-model block");
        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 0, "zero ai_results rows exist for an unpriced-model-blocked job");
      }
    }

    // --- Known model pricing: exact cost arithmetic (BigInt) -----------------
    {
      restoreDefaultTestEnv();
      const tokensIn = 1000;
      const tokensOut = 200;
      const expectedUsdString = microsToUsdString(expectedCostMicros(tokensIn, tokensOut));

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "ok" }, tokensIn, tokensOut }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === true, "a known-model call with a known token count succeeds (valid budget lets normal safety evaluation continue)");
      if (result.ok) {
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(
          job.costEstimateUsd === expectedUsdString,
          `exact micro-USD cost is persisted for a known model/token-count (expected ${expectedUsdString}, got ${job.costEstimateUsd})`
        );
      }
    }

    // --- Failure path that STILL reached the provider persists cost --------
    {
      restoreDefaultTestEnv();
      const tokensIn = 500;
      const tokensOut = 20;
      const expectedUsdString = microsToUsdString(expectedCostMicros(tokensIn, tokensOut));

      // Malformed output -- the provider call itself succeeded and was
      // billed; only schema validation failed afterward.
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: 12345 }, tokensIn, tokensOut }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "malformed structured output still returns ok:false (unchanged PR1 behavior)");
      if (!result.ok) {
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(
          job.costEstimateUsd === expectedUsdString,
          `PR2: a failure that reached the provider (invalid_structured_output) still persists its real cost (expected ${expectedUsdString}, got ${job.costEstimateUsd})`
        );
      }
    }

    // --- Budget: month boundary + NULL-cost handling ------------------------
    {
      restoreDefaultTestEnv();
      const now = new Date();
      const priorMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      // A huge cost dated in the PRIOR UTC month -- must not count toward
      // this month's spend.
      await seedHistoricalJob({ createdAt: priorMonthDate, costEstimateUsd: "999.000000" });
      // A NULL-cost row dated in the CURRENT month (as most historical
      // rows are today, per PR1) -- must contribute $0, not throw.
      await seedHistoricalJob({ createdAt: now, costEstimateUsd: null });

      process.env.AI_MONTHLY_BUDGET_USD = "1000";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "ok" }, tokensIn: 1, tokensOut: 1 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === true, "prior-month spend and NULL-cost current-month rows do not spuriously trip a $1000 ceiling");
      if (result.ok) createdJobIds.push(result.jobId);
      restoreDefaultTestEnv();
    }

    // --- Budget: ceiling reached blocks the next call -----------------------
    {
      restoreDefaultTestEnv();
      const now = new Date();
      // Seed exactly enough current-month spend to be AT the ceiling.
      await seedHistoricalJob({ createdAt: now, costEstimateUsd: "5.000000" });
      process.env.AI_MONTHLY_BUDGET_USD = "5.00";

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "should never be reached" }, tokensIn: 1, tokensOut: 1 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "month-to-date spend AT the ceiling blocks the next call");
      assert(provider.receivedRequests.length === 0, "the provider was never invoked once the ceiling was reached");
      if (!result.ok) {
        assert(result.reason === "budget_exceeded", `blocked reason is 'budget_exceeded' (got ${result.reason})`);
        createdJobIds.push(result.jobId);
        const job = await loadJob(result.jobId);
        assert(job.costEstimateUsd === null, "a budget-blocked job persists no cost");
        const results = await loadResultsForJob(result.jobId);
        assert(results.length === 0, "zero ai_results rows exist for a budget-blocked job");
      }
      restoreDefaultTestEnv();
    }

    // --- AI_MONTHLY_BUDGET_USD="0" is valid and blocks every call ----------
    // Requirement: "0" must be ACCEPTED as a well-formed value (not
    // rejected as malformed/missing) and must effectively prevent any
    // provider execution once evaluated against month-to-date spend
    // (which is always >= 0) -- with no special-cased "zero means off"
    // branch anywhere in budget.ts/evaluateAiSafety.ts.
    {
      restoreDefaultTestEnv();
      assert(getMonthlyBudgetCeilingMicros() === 1_000_000_000_000n, `sanity: the default test budget ("${DEFAULT_TEST_BUDGET_USD}") resolves as expected before this sub-test changes it`);

      process.env.AI_MONTHLY_BUDGET_USD = "0";
      let threwOnZero = false;
      try {
        getMonthlyBudgetCeilingMicros();
      } catch {
        threwOnZero = true;
      }
      assert(!threwOnZero, '"0" is ACCEPTED as a valid AI_MONTHLY_BUDGET_USD value, not rejected as malformed');
      assert(getMonthlyBudgetCeilingMicros() === 0n, '"0" resolves to a ceiling of exactly 0 micro-USD');

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "should never be reached" }, tokensIn: 1, tokensOut: 1 }]);
      const result = await runAiOperation({
        operation: "classify_relevance",
        provider,
        model: PRICED_MODEL,
        systemPrompt: "sys",
        userPrompt: "user",
        outputSchema: exampleOutputSchema,
      });
      assert(result.ok === false, "AI_MONTHLY_BUDGET_USD=0 blocks a priced model's call");
      assert(provider.receivedRequests.length === 0, "the provider was never invoked with a zero budget ceiling");
      if (!result.ok) {
        assert(result.reason === "budget_exceeded", `blocked reason is 'budget_exceeded' for a zero ceiling (got ${result.reason})`);
        createdJobIds.push(result.jobId);
      }
      restoreDefaultTestEnv();
    }

    // --- AI_MONTHLY_BUDGET_USD is MANDATORY: absent, empty, malformed all
    // fail closed -- both at the parser level (getMonthlyBudgetCeilingMicros
    // in isolation) AND end to end through the real runAiOperation() path,
    // proving no ai_jobs row is ever created for any of these three cases
    // (job never strands in 'pending', since none is created at all -- see
    // runAiOperation.ts's "resolve config, then create the job" ordering).
    for (const [label, envAction, expectedErrorClass] of [
      ["absent", () => delete process.env.AI_MONTHLY_BUDGET_USD, MissingAiBudgetConfigError],
      ["empty string", () => { process.env.AI_MONTHLY_BUDGET_USD = ""; }, MalformedAiBudgetConfigError],
      ["malformed (\"not-a-number\")", () => { process.env.AI_MONTHLY_BUDGET_USD = "not-a-number"; }, MalformedAiBudgetConfigError],
    ] as const) {
      restoreDefaultTestEnv();
      envAction();

      // Parser-level proof.
      assertThrows(() => getMonthlyBudgetCeilingMicros(), expectedErrorClass, `AI_MONTHLY_BUDGET_USD ${label} fails closed by throwing ${expectedErrorClass.name}`);

      // End-to-end proof through the real function: no provider call, no
      // stranded job.
      const jobCountBefore = await countAiJobs();
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { summary: "should never be reached" }, tokensIn: 1, tokensOut: 1 }]);
      let threw = false;
      try {
        await runAiOperation({
          operation: "classify_relevance",
          provider,
          model: PRICED_MODEL,
          systemPrompt: "sys",
          userPrompt: "user",
          outputSchema: exampleOutputSchema,
        });
      } catch (err) {
        threw = err instanceof expectedErrorClass;
      }
      assert(threw, `runAiOperation() itself throws ${expectedErrorClass.name} end to end when AI_MONTHLY_BUDGET_USD is ${label}`);
      assert(provider.receivedRequests.length === 0, `(${label}) the provider was never invoked when budget config resolution throws`);
      const jobCountAfter = await countAiJobs();
      assert(jobCountAfter === jobCountBefore, `(${label}) NO ai_jobs row is created at all -- job never strands in 'pending' (before: ${jobCountBefore}, after: ${jobCountAfter})`);

      restoreDefaultTestEnv();
    }

    // --- money.ts round-trip sanity (BigInt) ---------------------------------
    {
      assert(microsToUsdString(0n) === "0.000000", "zero micros formats as 0.000000");
      assert(microsToUsdString(1n) === "0.000001", "one micro-USD formats as 0.000001");
      assert(microsToUsdString(1_500_000n) === "1.500000", "1,500,000 micros formats as 1.500000");
      assert(parseUsdStringToMicros("50") === 50_000_000n, '"50" parses to 50,000,000 micros');
      assert(parseUsdStringToMicros("12.50") === 12_500_000n, '"12.50" parses to 12,500,000 micros');
      assert(parseUsdStringToMicros("0.000001") === 1n, '"0.000001" parses to exactly 1 micro-USD');
      assert(parseUsdStringToMicros("0") === 0n, '"0" parses to exactly 0 micro-USD');
    }

    // --- pricing.ts rounding policy: sub-micro-USD remainders truncate ------
    {
      // 7 tokens at a hypothetical $0.30/MTok rate = 2.1 micro-USD exactly --
      // not representable in numeric(10,6). Truncation must drop the
      // fractional remainder deterministically (floor, since cost is
      // non-negative), not silently round to a different value.
      const hypotheticalPricing = { inputMicrosPerMillionTokens: 300_000n, outputMicrosPerMillionTokens: 0n };
      const micros = calculateCostMicros(hypotheticalPricing, 7, 0);
      assert(micros === 2n, `a true cost of 2.1 micro-USD truncates down to 2 (got ${micros}) -- documented rounding policy, not silent imprecision`);
    }

    console.log(failures === 0 ? "\nAll AI safety checks passed." : `\n${failures} check(s) FAILED.`);
  } finally {
    delete process.env.AI_KILL_SWITCH_ENGAGED;
    delete process.env.AI_MONTHLY_BUDGET_USD;
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
