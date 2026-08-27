/**
 * Phase 5 PR 7 compare_claims recovery path -- thin, domain-specific
 * wrapper over the shared, operation-agnostic logic in
 * src/lib/ai/aiJobRecoveryLifecycle.ts. Structurally identical to
 * detectDuplicatesRecoveryLifecycle.ts's own wrapper (both wrap the same
 * shared module), but deliberately its own file with its own threshold
 * constant and its own vocabulary for the shared 'missing' state -- see
 * aiJobRecoveryLifecycle.ts's header for why these operations'
 * thresholds/labels are not merged into one.
 *
 * This module only knows about ONE job snapshot at a time -- it has no
 * idea a compare_claims job is additionally scoped by comparisonClaimId
 * rather than sourceItemId or the extraction pair; that distinction lives
 * in the DB query (getLatestCompareClaimsJob) and the recovery mutation
 * (compareClaimsRecovery.ts), not here.
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs, type AiJobDisplayStatus } from "./aiJobRecoveryLifecycle";

/**
 * Staleness window for an in-flight compare_claims job. Starts equal to
 * classify_relevance's/extract_claims'/detect_duplicates' own threshold
 * (5 minutes), but is a distinct, independently tunable constant -- this
 * operation's real production latency may warrant a different window
 * once observed.
 */
export const COMPARE_CLAIMS_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightCompareClaimsJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

export function compareClaimsJobAgeMs(job: InFlightCompareClaimsJobSnapshot, now: Date): number {
  return aiJobAgeMs(job, now);
}

export function isStaleInFlightCompareClaimsJob(
  job: InFlightCompareClaimsJobSnapshot,
  now: Date,
  thresholdMs: number = COMPARE_CLAIMS_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return isStaleInFlightAiJob(job, now, thresholdMs);
}

/**
 * compare_claims' own vocabulary for the shared 'missing' state --
 * "not_analysed" (distinct from extraction's "unextracted",
 * classification's "unclassified", and detect_duplicates'
 * "not_checked"), presented to admins as its own concept for a given
 * focus claim.
 *
 * This is the JOB-STATUS half of PR7's six-state display model. The
 * sixth state, "no_comparable_claims", is NOT a job-status concept at
 * all -- it is computed independently in
 * relationshipAnalysisActionability.ts from whether any comparable
 * claims exist (same project, not the claim itself, not already
 * related), entirely regardless of job history -- so it is deliberately
 * NOT one of the five values below.
 *
 * PR7 deliberately provides no re-analysis control from a "succeeded"
 * state (locked decision, mirroring PR6's identical restraint) -- this
 * type still names the state for display purposes, it is simply never
 * mapped to an action.
 */
export type CompareClaimsJobDisplayStatus = "not_analysed" | "in_progress" | "stale" | "failed" | "succeeded";

export interface CompareClaimsJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

function toCompareClaimsJobDisplayStatus(shared: AiJobDisplayStatus): CompareClaimsJobDisplayStatus {
  return shared === "missing" ? "not_analysed" : shared;
}

/**
 * Maps the most recent compare_claims ai_jobs row for a focus claim (or
 * null, if none exists at all) onto exactly one of five job-status
 * states. Delegates the actual state computation to the shared module;
 * only relabels 'missing' -> 'not_analysed' for this operation's callers.
 */
export function computeCompareClaimsJobDisplayStatus(
  job: CompareClaimsJobForDisplay | null,
  now: Date,
  thresholdMs: number = COMPARE_CLAIMS_RECOVERY_STALE_THRESHOLD_MS
): CompareClaimsJobDisplayStatus {
  return toCompareClaimsJobDisplayStatus(computeAiJobDisplayStatus(job, now, thresholdMs));
}
