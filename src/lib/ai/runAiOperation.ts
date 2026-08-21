import "server-only";
import type { z } from "zod";
import { createPendingAiJob, markAiJobRunning, completeAiJobSuccess, completeAiJobFailure } from "@/db/mutations/aiJobs";
import { getDefaultModel } from "./config";
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
  jobId: number;
  reason: "provider_error" | "invalid_structured_output";
  message: string;
}

export type RunAiOperationResult<T> = RunAiOperationSuccess<T> | RunAiOperationFailure;

export async function runAiOperation<T>(input: RunAiOperationInput<T>): Promise<RunAiOperationResult<T>> {
  const model = input.model ?? getDefaultModel();

  const job = await createPendingAiJob({
    operation: input.operation,
    provider: input.provider.name,
    model,
    inputRef: input.inputRef ?? null,
  });

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
    });
  } catch (err) {
    // A conforming AiProvider should never throw (see types.ts), but a
    // job must always reach a terminal state regardless -- an unexpected
    // throw is treated as a provider_error, same as a well-behaved
    // provider's own reported failure would be.
    const message = err instanceof Error ? err.message : String(err);
    await completeAiJobFailure({ jobId: job.id, error: `provider_error: ${message}` });
    return { ok: false, jobId: job.id, reason: "provider_error", message };
  }

  if (!result.ok) {
    await completeAiJobFailure({
      jobId: job.id,
      error: `${result.reason}: ${result.message}`,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
    });
    return { ok: false, jobId: job.id, reason: result.reason, message: result.message };
  }

  const completed = await completeAiJobSuccess({
    jobId: job.id,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
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
