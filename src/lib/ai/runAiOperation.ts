import "server-only";
import type { z } from "zod";
import { createPendingAiJob, markAiJobRunning, completeAiJobSuccess, completeAiJobFailure } from "@/db/mutations/aiJobs";
import { getDefaultModel } from "./config";
import { getMonthlyBudgetCeilingMicros } from "./safety/budget";
import { evaluateAiSafety, type AiSafetyBlockedReason } from "./safety/evaluateAiSafety";
import { calculateCostMicros } from "./safety/pricing";
import { microsToUsdString } from "./safety/money";
import type { AiOperation, AiProvider, AiCompletionResult } from "./types";

/**
 * Phase 5 PR 1: the one generic entry point every future real operation
 * (classifyRelevance, extractClaims, compareClaims, analyseProvenance,
 * evaluateEvidence, recommendStatus, detectDuplicates) is expected to
 * call, rather than talking to an AiProvider or ai_jobs/ai_results
 * directly. This is deliberately the ONLY function in this PR that knows
 * about the full pending -> running -> succeeded/failed lifecycle end to
 * end -- callers just describe the request and get back a typed result.
 *
 * This file contains no operation-specific prompts, schemas, or business
 * logic -- see types.ts's header comment for why that separation matters.
 *
 * Phase 5 PR 2 adds the mandatory safety checkpoint (see "SAFETY CHECK"
 * below) between job creation and the actual provider call -- this is the
 * single central enforcement boundary described in
 * src/lib/ai/safety/evaluateAiSafety.ts's header. Every current and
 * future caller of runAiOperation() is protected automatically; no caller
 * needs to remember to check a budget or kill switch itself.
 */

export interface RunAiOperationInput<T> {
  operation: AiOperation;
  provider: AiProvider;
  /** Explicit override. If omitted, config.getDefaultModel() is used -- callers should never hardcode a provider-specific model id (Section 9). */
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: z.ZodType<T>;
  inputRef?: string;
  /** Passed straight through to ai_results.claim_id if this operation happens to be about a specific claim. Opaque to this function. */
  claimId?: number | null;
  /**
   * Phase 5 PR 3: opaque passthrough to ai_jobs.source_item_id, mirroring
   * claimId above -- but written at PENDING-job-creation time (not just
   * on success), since it's what the in-flight uniqueness guard
   * (migration 0014) checks against. This function has no idea which
   * operation actually uses this; any future source-item-scoped
   * operation can supply it identically.
   */
  sourceItemId?: number | null;
  /**
   * Phase 5 PR 6: opaque passthrough to ai_jobs.extraction_ai_result_id /
   * .extraction_candidate_index, mirroring sourceItemId immediately
   * above -- same "written at pending-job-creation time, since the
   * in-flight uniqueness guard (migration 0018) checks against it"
   * reasoning, just one level narrower (one extract_claims candidate,
   * not one whole source item). This function has no idea only
   * detect_duplicates populates these.
   */
  extractionAiResultId?: number | null;
  extractionCandidateIndex?: number | null;
  /**
   * Phase 5 PR 7: opaque passthrough to ai_jobs.comparison_claim_id,
   * mirroring extractionAiResultId/extractionCandidateIndex immediately
   * above -- same "written at pending-job-creation time, since the
   * in-flight uniqueness guard (migration 0021) checks against it"
   * reasoning, just scoped to one EXISTING focus claim rather than one
   * extract_claims candidate. This function has no idea only
   * compare_claims populates this.
   */
  comparisonClaimId?: number | null;
  /**
   * Phase 5 PR 8b: opaque passthrough to ai_jobs.provenance_claim_id /
   * .provenance_cluster_fingerprint, mirroring comparisonClaimId
   * immediately above -- same "written at pending-job-creation time,
   * since the in-flight uniqueness guard (migration 0024) checks
   * against it" reasoning, just scoped to one claim's linked
   * source-item cluster rather than one focus-claim comparison. This
   * function has no idea only analyse_provenance populates these.
   */
  provenanceClaimId?: number | null;
  provenanceClusterFingerprint?: string | null;
  /**
   * Explicit metadata passthrough to ai_results.confidence /
   * ai_results.reasoning -- the SAME mechanism as claimId above, not a
   * new one. This function never inspects `outputSchema`'s validated
   * data for a `confidence` or `reasoning` property; a future operation
   * (e.g. classifyRelevance) that wants these columns populated must
   * explicitly map its own output into these two fields itself when it
   * calls runAiOperation. Leaving both omitted (the only option in PR1,
   * since no real operation exists yet) persists NULL in both columns --
   * that is the correct, intended PR1 behavior, not a gap.
   */
  confidence?: number | null;
  reasoning?: string | null;
  /**
   * Phase 5 PR 4: opaque passthrough to AiCompletionRequest.maxOutputTokens
   * (types.ts) -- this function has no opinion on what a sensible value
   * is for any given operation; it just forwards whatever the caller
   * supplies straight to the provider call below. Omitted -> the
   * provider's own default applies, unchanged from PR1/PR2/PR3 behavior.
   */
  maxOutputTokens?: number;
}

export interface RunAiOperationSuccess<T> {
  ok: true;
  jobId: number;
  aiResultId: number;
  data: T;
  tokensIn: number;
  tokensOut: number;
}

export interface RunAiOperationFailure {
  ok: false;
  /**
   * Phase 5 PR 3: null exactly when NO ai_jobs row was ever created for
   * this call -- currently only the "already_in_flight" case, where the
   * pending-job INSERT itself was rejected by
   * ai_jobs_classify_relevance_inflight_unique before any row could exist. Every
   * other failure reason still creates and terminalizes a real row, same
   * as before, so jobId is only ever null for that one reason.
   */
  jobId: number | null;
  /**
   * Phase 5 PR 2 adds the three AiSafetyBlockedReason values alongside
   * PR 1's original two -- a blocked execution is a distinct KIND of
   * failure (it never reached the provider at all) from a provider-side
   * or validation failure, but it is still surfaced through this same
   * result shape rather than a new one, matching how ai_jobs.error's text
   * (not a new enum value) is what actually distinguishes all five cases
   * on the persisted row -- see aiJobLifecycle.ts's buildFailurePatch.
   * Phase 5 PR 3 adds a fourth kind, "already_in_flight" -- distinct from
   * all of these because it never even creates an ai_jobs row (see
   * jobId's doc comment above).
   */
  reason: "provider_error" | "invalid_structured_output" | AiSafetyBlockedReason | "already_in_flight";
  message: string;
}

export type RunAiOperationResult<T> = RunAiOperationSuccess<T> | RunAiOperationFailure;

export async function runAiOperation<T>(input: RunAiOperationInput<T>): Promise<RunAiOperationResult<T>> {
  const model = input.model ?? getDefaultModel();

  // Resolved BEFORE any job row is created, same ordering as
  // getDefaultModel() above -- AI_MONTHLY_BUDGET_USD is mandatory
  // (MissingAiBudgetConfigError if unset, MalformedAiBudgetConfigError if
  // set but invalid) -- both are true misconfigurations, not ordinary
  // operational outcomes, so they throw here rather than producing a
  // dangling 'pending' job with no way to reach a terminal state.
  const budgetCeilingMicros = getMonthlyBudgetCeilingMicros();

  const created = await createPendingAiJob({
    operation: input.operation,
    provider: input.provider.name,
    model,
    inputRef: input.inputRef ?? null,
    sourceItemId: input.sourceItemId ?? null,
    extractionAiResultId: input.extractionAiResultId ?? null,
    extractionCandidateIndex: input.extractionCandidateIndex ?? null,
    comparisonClaimId: input.comparisonClaimId ?? null,
    provenanceClaimId: input.provenanceClaimId ?? null,
    provenanceClusterFingerprint: input.provenanceClusterFingerprint ?? null,
  });

  // Phase 5 PR 3: the pending-job INSERT itself can be rejected by
  // ai_jobs_classify_relevance_inflight_unique (migration 0014) -- another
  // in-flight execution already exists for this exact source item's
  // classify_relevance job. This is an ordinary, expected race
  // outcome, not a misconfiguration or provider failure: NO row was
  // created for this call, so jobId is null here (see
  // RunAiOperationFailure.jobId's doc comment) and neither the safety
  // gate nor the provider is ever reached.
  if (!created.ok) {
    return {
      ok: false,
      jobId: null,
      reason: "already_in_flight",
      message: `An in-flight ${input.operation} execution already exists for this source item.`,
    };
  }
  const job = created;

  // --- SAFETY CHECK (Phase 5 PR 2) ---------------------------------------
  // The single central enforcement boundary: kill switch, unpriced model,
  // and monthly budget ceiling are all evaluated here, strictly before
  // markAiJobRunning()/provider.complete() are ever reached. A blocked
  // call is recorded straight to 'failed' -- it deliberately never passes
  // through 'running', since no provider call was attempted -- with zero
  // cost persisted, since nothing was spent. See evaluateAiSafety.ts.
  const safety = await evaluateAiSafety({ model, budgetCeilingMicros });
  if (!safety.allowed) {
    const message = safety.message;
    await completeAiJobFailure({ jobId: job.id, error: `${safety.reason}: ${message}` });
    return { ok: false, jobId: job.id, reason: safety.reason, message };
  }
  const { pricing } = safety;

  await markAiJobRunning(job.id);

  let result: AiCompletionResult<T>;
  try {
    result = await input.provider.complete({
      operation: input.operation,
      model,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      outputSchema: input.outputSchema,
      inputRef: input.inputRef,
      maxOutputTokens: input.maxOutputTokens,
    });
  } catch (err) {
    // A conforming AiProvider should never throw (see types.ts), but a
    // job must always reach a terminal state regardless -- an unexpected
    // throw is treated as a provider_error, same as a well-behaved
    // provider's own reported failure would be. No token counts are
    // available from a bare throw, so cost is left null -- unmeasurable,
    // not zero (see budget.ts's hasUnmeasuredRows).
    const message = err instanceof Error ? err.message : String(err);
    await completeAiJobFailure({ jobId: job.id, error: `provider_error: ${message}` });
    return { ok: false, jobId: job.id, reason: "provider_error", message };
  }

  if (!result.ok) {
    // Phase 5 PR 2: a failure this far in (provider_error after a partial
    // response, or invalid_structured_output) may still have consumed
    // real, billable tokens -- compute and persist cost whenever the
    // provider actually reported token counts, same pricing used for the
    // success path below.
    const tokensIn = result.tokensIn ?? null;
    const tokensOut = result.tokensOut ?? null;
    const costEstimateUsd =
      tokensIn !== null && tokensOut !== null ? microsToUsdString(calculateCostMicros(pricing, tokensIn, tokensOut)) : null;
    await completeAiJobFailure({
      jobId: job.id,
      error: `${result.reason}: ${result.message}`,
      tokensIn,
      tokensOut,
      costEstimateUsd,
    });
    return { ok: false, jobId: job.id, reason: result.reason, message: result.message };
  }

  const costEstimateUsd = microsToUsdString(calculateCostMicros(pricing, result.tokensIn, result.tokensOut));

  const completed = await completeAiJobSuccess({
    jobId: job.id,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costEstimateUsd,
    structuredOutput: result.data,
    confidence: input.confidence ?? null,
    reasoning: input.reasoning ?? null,
    claimId: input.claimId ?? null,
  });

  return {
    ok: true,
    jobId: job.id,
    aiResultId: completed.aiResultId,
    data: result.data,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
}
