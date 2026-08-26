/**
 * Phase 5 PR 6 detect_duplicates recovery path -- thin, domain-specific
 * wrapper over the shared, operation-agnostic logic in
 * src/lib/ai/aiJobRecoveryLifecycle.ts. Structurally identical to
 * extractClaimsRecoveryLifecycle.ts's own wrapper (both wrap the same
 * shared module), but deliberately its own file with its own threshold
 * constant and its own vocabulary for the shared 'missing' state --
 * see aiJobRecoveryLifecycle.ts's header for why these operations'
 * thresholds/labels are not merged into one.
 *
 * This module only knows about ONE job snapshot at a time -- it has no
 * idea a detect_duplicates job is additionally scoped by
 * (extraction_ai_result_id, extraction_candidate_index) rather than
 * source_item_id; that distinction lives in the DB query
 * (getLatestDetectDuplicatesJob) and the recovery mutation
 * (detectDuplicatesRecovery.ts), not here.
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs, type AiJobDisplayStatus } from "./aiJobRecoveryLifecycle";

/**
 * Staleness window for an in-flight detect_duplicates job. Starts equal
 * to extract_claims'/classify_relevance's own threshold, but is a
 * distinct, independently tunable constant -- this operation's real
 * production latency may warrant a different window once observed.
 */
export const DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightDetectDuplicatesJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

export function detectDuplicatesJobAgeMs(job: InFlightDetectDuplicatesJobSnapshot, now: Date): number {
  return aiJobAgeMs(job, now);
}

export function isStaleInFlightDetectDuplicatesJob(
  job: InFlightDetectDuplicatesJobSnapshot,
  now: Date,
  thresholdMs: number = DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return isStaleInFlightAiJob(job, now, thresholdMs);
}

/**
 * detect_duplicates' own vocabulary for the shared 'missing' state --
 * "not_checked" (distinct from extraction's "unextracted" and
 * classification's "unclassified"), presented to admins as its own
 * concept for a given candidate.
 *
 * This is the JOB-STATUS half of PR6's six-state display model. The
 * sixth state, "no_existing_claims", is NOT a job-status concept at all
 * -- it is computed independently in duplicateCheckActionability.ts from
 * whether any claims exist to compare against, entirely regardless of
 * job history (a job can never exist for a candidate checked while zero
 * claims existed, since detectDuplicatesTrigger.ts never creates one in
 * that case) -- so it is deliberately NOT one of the five values below.
 */
export type DetectDuplicatesJobDisplayStatus = "not_checked" | "in_progress" | "stale" | "failed" | "succeeded";

export interface DetectDuplicatesJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

function toDetectDuplicatesJobDisplayStatus(shared: AiJobDisplayStatus): DetectDuplicatesJobDisplayStatus {
  return shared === "missing" ? "not_checked" : shared;
}

/**
 * Maps the most recent detect_duplicates ai_jobs row for a candidate (or
 * null, if none exists at all) onto exactly one of five job-status
 * states. Delegates the actual state computation to the shared module;
 * only relabels 'missing' -> 'not_checked' for this operation's callers.
 */
export function computeDetectDuplicatesJobDisplayStatus(
  job: DetectDuplicatesJobForDisplay | null,
  now: Date,
  thresholdMs: number = DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS
): DetectDuplicatesJobDisplayStatus {
  return toDetectDuplicatesJobDisplayStatus(computeAiJobDisplayStatus(job, now, thresholdMs));
}
