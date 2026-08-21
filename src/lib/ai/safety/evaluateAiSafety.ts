import "server-only";
import { isKillSwitchEngaged } from "./killSwitch";
import { getModelPricing, type ModelPricing } from "./pricing";
import { getMonthToDateSpendMicros } from "./budget";
import { microsToUsdString } from "./money";

/**
 * Phase 5 PR 2: the SINGLE central safety boundary for real AI execution.
 * Called from runAiOperation() -- and ONLY from runAiOperation() -- after
 * the pending ai_jobs row has already been created, but strictly before
 * markAiJobRunning()/provider.complete() are ever reached. This is
 * deliberately not duplicated into AnthropicProvider or into individual
 * future operations (classifyRelevance, extractClaims, ...): Section 9 of
 * the project's standing rules explicitly says not to scatter
 * budget/safety logic into the provider layer or into operation-specific
 * code, and runAiOperation() is already confirmed (by direct repository
 * inspection) to be the only call site that constructs/uses a real
 * AiProvider in production -- so gating it here is sufficient, not
 * partial.
 *
 * Applies IDENTICALLY regardless of which AiProvider instance was passed
 * in, including the test-only FakeAiProvider. This is intentional, not
 * an oversight: distinguishing "this is a real, billable provider" from
 * "this is a test double" would require providers to self-report their
 * own billability, which is itself a value nothing prevents a future
 * provider from mis-reporting. A single guard that doesn't care about
 * provider identity is strictly harder to accidentally bypass, and lets
 * checks prove the guard's behavior (kill switch blocks; budget blocks)
 * using nothing but FakeAiProvider, on the exact same code path
 * production traffic runs through.
 *
 * `budgetCeilingMicros` is passed in already-resolved (see
 * budget.ts's getMonthlyBudgetCeilingMicros(), which now THROWS on both
 * a missing and a malformed value -- AI_MONTHLY_BUDGET_USD is mandatory
 * as of this PR, with no "unset means unlimited spend" fallback) -- that
 * throw is a true misconfiguration and is deliberately handled by
 * runAiOperation() BEFORE it ever creates a pending job row, the same
 * "resolve config, THEN create the job" ordering this file's caller
 * already uses for getDefaultModel(). This function itself never throws
 * for an ordinary, expected operational outcome (switch engaged /
 * unpriced model / budget exceeded) -- those are normal production
 * states, returned as a typed blocked result, not exceptions.
 */

export type AiSafetyBlockedReason = "kill_switch_engaged" | "unknown_model_pricing" | "budget_exceeded";

export type AiSafetyEvaluation =
  | { allowed: true; pricing: ModelPricing }
  | { allowed: false; reason: AiSafetyBlockedReason; message: string };

export interface EvaluateAiSafetyInput {
  model: string;
  /** Already-resolved monthly ceiling in integer micro-USD (BigInt) -- always present, since AI_MONTHLY_BUDGET_USD is mandatory (getMonthlyBudgetCeilingMicros() throws rather than returning null for an unset value). "0" is a valid, deliberately restrictive ceiling -- see budget.ts. */
  budgetCeilingMicros: bigint;
  now?: Date;
}

export async function evaluateAiSafety(input: EvaluateAiSafetyInput): Promise<AiSafetyEvaluation> {
  if (isKillSwitchEngaged()) {
    return {
      allowed: false,
      reason: "kill_switch_engaged",
      message: "AI_KILL_SWITCH_ENGAGED is set -- refusing to invoke any AI provider until it is cleared.",
    };
  }

  // Checked before the budget query: an unpriced model's cost can never
  // be measured, so its spend would be permanently invisible to the
  // ceiling below -- that's the uncontrolled-spend hole this closes,
  // fixed closed (block) rather than open (silently proceed with an
  // unmeasured call).
  const pricing = getModelPricing(input.model);
  if (!pricing) {
    return {
      allowed: false,
      reason: "unknown_model_pricing",
      message: `No pricing entry exists for model "${input.model}" in src/lib/ai/safety/pricing.ts -- refusing to invoke a provider whose cost cannot be measured. Add an entry to PRICING before using this model.`,
    };
  }

  // Unconditional -- AI_MONTHLY_BUDGET_USD is mandatory, so there is no
  // longer a "no ceiling configured" state to special-case here. A
  // ceiling of exactly 0 blocks every call once evaluated (month-to-date
  // spend is always >= 0), with no separate "zero means off" branch
  // needed -- see budget.ts's header on getMonthlyBudgetCeilingMicros().
  const now = input.now ?? new Date();
  const { spentMicros, hasUnmeasuredRows } = await getMonthToDateSpendMicros(now);
  if (hasUnmeasuredRows) {
    // Section 19 (observability): surfaced as a log line, not a block --
    // historical/blocked-before-provider rows are expected to be NULL,
    // this is a heads-up that spend may be understated, not an error.
    console.warn(
      "[ai-safety] Month-to-date spend calculation excluded one or more ai_jobs rows with a NULL cost_estimate_usd -- reported spend may understate actual spend."
    );
  }
  if (spentMicros >= input.budgetCeilingMicros) {
    return {
      allowed: false,
      reason: "budget_exceeded",
      message: `Month-to-date AI spend (${microsToUsdString(spentMicros)} USD) has reached or exceeded AI_MONTHLY_BUDGET_USD (${microsToUsdString(input.budgetCeilingMicros)} USD).`,
    };
  }

  return { allowed: true, pricing };
}
