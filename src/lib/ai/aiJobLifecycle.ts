/**
 * Pure decision/patch-building logic for `ai_jobs` state transitions,
 * kept separate from the actual database reads/writes
 * (src/db/mutations/aiJobs.ts) -- same rationale and shape as
 * src/lib/ingestion/ingestionJobLifecycle.ts: these functions are plain,
 * deterministic, and take an injected clock, so the lifecycle itself is
 * checkable with in-memory objects and no database.
 *
 * Phase 5 PR 1 deliberately mirrors ingestion's queued -> fetching ->
 * terminal shape as pending -> running -> succeeded/failed, even though
 * PR 1's only caller (runAiOperation.ts) drives all three transitions
 * back-to-back with no real queueing yet -- keeping the three-step shape
 * now means a future queued/cron-driven AI processor (if PR 3+ needs
 * one, the same open question ingestionProcessor.ts answered for
 * ingestion) can reuse these functions without redesigning them.
 *
 * No retry/backoff logic exists here (unlike ingestionJobLifecycle.ts's
 * computeRetryDelayMs) -- ai_jobs has no attempt_count/next_retry_at
 * columns yet, and Phase 5 PR 1's scope explicitly excludes introducing
 * a retry scheduler.
 */

import type { AiOperation } from "./types";

export interface PendingAiJobInput {
  operation: AiOperation;
  provider: string;
  model: string;
  inputRef?: string | null;
}

export interface PendingAiJobValues {
  operation: AiOperation;
  provider: string;
  model: string;
  status: "pending";
  inputRef: string | null;
}

/** Section 19 (observability): every field here is exactly what gets persisted -- no defaults are silently applied beyond status itself. */
export function buildPendingAiJobValues(input: PendingAiJobInput): PendingAiJobValues {
  return {
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    status: "pending",
    inputRef: input.inputRef ?? null,
  };
}

export interface RunningAiJobPatch {
  status: "running";
  startedAt: Date;
}

/** Section 3-equivalent for AI jobs: startedAt is set here, when the provider call actually begins -- never at job creation (createdAt already covers queue time). */
export function buildRunningPatch(now: Date): RunningAiJobPatch {
  return { status: "running", startedAt: now };
}

export interface SuccessAiJobPatch {
  status: "succeeded";
  completedAt: Date;
  tokensIn: number;
  tokensOut: number;
  costEstimateUsd: string | null;
  error: null;
}

/**
 * `costEstimateUsd` is left null unless the caller explicitly supplies
 * one -- PR 1 has no per-model pricing table (that is squarely Phase 5
 * PR 2's cost-control territory, per the approved PR1 scope), so this
 * does not invent one. Stored as a string because Drizzle's `numeric`
 * column type expects string input, matching how the Phase 1 seed data
 * writes it (see src/db/seed/seed.ts).
 */
export function buildSuccessPatch(params: {
  now: Date;
  tokensIn: number;
  tokensOut: number;
  costEstimateUsd?: number | null;
}): SuccessAiJobPatch {
  return {
    status: "succeeded",
    completedAt: params.now,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    costEstimateUsd: params.costEstimateUsd != null ? params.costEstimateUsd.toFixed(6) : null,
    error: null,
  };
}

export interface FailureAiJobPatch {
  status: "failed";
  completedAt: Date;
  error: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/**
 * Covers BOTH a provider-side failure and a structured-output validation
 * failure (AiCompletionFailureReason distinguishes them) -- `ai_job_status`
 * intentionally has no separate value for the two, per the approved PR1
 * scope ("don't introduce unnecessary schema"). The distinction is
 * preserved in `error`'s text (see runAiOperation.ts), not in a new enum
 * value.
 */
export function buildFailurePatch(params: {
  now: Date;
  error: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}): FailureAiJobPatch {
  return {
    status: "failed",
    completedAt: params.now,
    error: params.error,
    tokensIn: params.tokensIn ?? null,
    tokensOut: params.tokensOut ?? null,
  };
}
