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
  /**
   * Phase 5 PR 3: opaque passthrough, mirrors ai_results' claimId exactly
   * but populated at PENDING-job-creation time rather than only on
   * success -- the partial unique index on source_item_id (scoped to
   * operation = 'classify_relevance', migration 0014) needs it present
   * from the moment the row is inserted, since that INSERT is exactly
   * what the index either accepts
   * or rejects. This file remains entirely operation-agnostic: it has no
   * idea this is used by classify_relevance specifically.
   */
  sourceItemId?: number | null;
  /**
   * Phase 5 PR 6: opaque passthrough, one level narrower than
   * sourceItemId above -- mirrors the same "populated at PENDING-job-
   * creation time, since the in-flight partial unique index (migration
   * 0018) needs it present from the moment the row is inserted" reasoning,
   * just scoped to one extract_claims candidate instead of one source
   * item. This file remains entirely operation-agnostic: it has no idea
   * this pair is used by detect_duplicates specifically.
   */
  extractionAiResultId?: number | null;
  extractionCandidateIndex?: number | null;
}

export interface PendingAiJobValues {
  operation: AiOperation;
  provider: string;
  model: string;
  status: "pending";
  inputRef: string | null;
  sourceItemId: number | null;
  extractionAiResultId: number | null;
  extractionCandidateIndex: number | null;
}

/** Section 19 (observability): every field here is exactly what gets persisted -- no defaults are silently applied beyond status itself. */
export function buildPendingAiJobValues(input: PendingAiJobInput): PendingAiJobValues {
  return {
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    status: "pending",
    inputRef: input.inputRef ?? null,
    sourceItemId: input.sourceItemId ?? null,
    extractionAiResultId: input.extractionAiResultId ?? null,
    extractionCandidateIndex: input.extractionCandidateIndex ?? null,
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
 * `costEstimateUsd` (Phase 5 PR 2): the caller supplies an already
 * exact-formatted numeric(10,6) string -- see
 * src/lib/ai/safety/money.ts's `microsToUsdString()` -- rather than a raw
 * JS number for this function to `.toFixed()` itself. PR 1's original
 * signature took a `number` and called `.toFixed(6)` on it directly, but
 * that call site never actually ran in practice (no pricing table
 * existed yet, so it was always null); doing float-to-string formatting
 * here would reintroduce exactly the binary-floating-point imprecision
 * this project's own `z.coerce.boolean()` lesson warns against for a
 * different column type, now that PR 2 actually populates this value
 * from real per-token pricing. Computing the exact string is the
 * caller's job (runAiOperation.ts, via the safety/pricing module); this
 * function only ever passes the string straight through to the
 * `numeric` column, matching how the Phase 1 seed data writes it (see
 * src/db/seed/seed.ts).
 */
export function buildSuccessPatch(params: {
  now: Date;
  tokensIn: number;
  tokensOut: number;
  costEstimateUsd?: string | null;
}): SuccessAiJobPatch {
  return {
    status: "succeeded",
    completedAt: params.now,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    costEstimateUsd: params.costEstimateUsd ?? null,
    error: null,
  };
}

export interface FailureAiJobPatch {
  status: "failed";
  completedAt: Date;
  error: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costEstimateUsd: string | null;
}

/**
 * Covers a provider-side failure, a structured-output validation failure,
 * AND (Phase 5 PR 2) a safety-blocked execution that never reached the
 * provider at all (kill switch / unknown model pricing / budget
 * exceeded) -- `ai_job_status` intentionally has no separate value for
 * any of these, per the approved PR1 scope ("don't introduce unnecessary
 * schema"), extended by PR2 rather than replaced. The distinction is
 * preserved in `error`'s text (see runAiOperation.ts), not in a new enum
 * value.
 *
 * `costEstimateUsd` (Phase 5 PR 2): a failure can still have consumed
 * real, billable tokens -- e.g. invalid_structured_output means the
 * provider call succeeded and was billed, only the response shape was
 * rejected afterward. Omitting cost on the failure path (as PR1 did)
 * would make the monthly budget ceiling systematically undercount spend.
 * A safety-blocked failure (never reached the provider) correctly passes
 * no cost here, since nothing was spent.
 */
export function buildFailurePatch(params: {
  now: Date;
  error: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costEstimateUsd?: string | null;
}): FailureAiJobPatch {
  return {
    status: "failed",
    completedAt: params.now,
    error: params.error,
    tokensIn: params.tokensIn ?? null,
    tokensOut: params.tokensOut ?? null,
    costEstimateUsd: params.costEstimateUsd ?? null,
  };
}
