/**
 * Phase 5 PR 8b analyse_provenance recovery path -- thin, domain-specific
 * wrapper over the shared, operation-agnostic logic in
 * src/lib/ai/aiJobRecoveryLifecycle.ts. Structurally identical to
 * compareClaimsRecoveryLifecycle.ts's own wrapper (both wrap the same
 * shared module), but deliberately its own file with its own threshold
 * constant and its own vocabulary for the shared 'missing' state -- same
 * reasoning that file's header gives for not merging operations'
 * thresholds/labels together.
 *
 * This module only knows about ONE job snapshot at a time -- it has no
 * idea an analyse_provenance job is additionally scoped by
 * provenanceClaimId rather than sourceItemId, the extraction pair, or
 * comparisonClaimId; that distinction lives in the DB query
 * (getLatestProvenanceAnalysisJob) and the recovery mutation
 * (provenanceAnalysisRecovery.ts), not here.
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs, type AiJobDisplayStatus } from "./aiJobRecoveryLifecycle";

/**
 * Staleness window for an in-flight analyse_provenance job. Starts equal
 * to every sibling operation's own threshold (5 minutes), but is a
 * distinct, independently tunable constant -- this operation's real
 * production latency may warrant a different window once observed,
 * especially given its larger worst-case output size (up to
 * MAX_PROVENANCE_EDGES edges vs compare_claims' 6 assessments).
 */
export const PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightProvenanceAnalysisJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

export function provenanceAnalysisJobAgeMs(job: InFlightProvenanceAnalysisJobSnapshot, now: Date): number {
  return aiJobAgeMs(job, now);
}

export function isStaleInFlightProvenanceAnalysisJob(
  job: InFlightProvenanceAnalysisJobSnapshot,
  now: Date,
  thresholdMs: number = PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return isStaleInFlightAiJob(job, now, thresholdMs);
}

/**
 * analyse_provenance's own vocabulary for the shared 'missing' state --
 * "not_analysed", presented to admins as its own concept for a given
 * anchor claim.
 *
 * This is the JOB-STATUS half of PR8b's six-state display model. The
 * sixth state, "no_analysable_cluster", is NOT a job-status concept at
 * all -- it is computed independently in provenanceAnalysisActionability.ts
 * from the claim's linked source-item cluster size, entirely regardless
 * of job history -- so it is deliberately NOT one of the five values
 * below. Same split as compare_claims' "no_comparable_claims".
 */
export type ProvenanceAnalysisJobDisplayStatus = "not_analysed" | "in_progress" | "stale" | "failed" | "succeeded";

export interface ProvenanceAnalysisJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

function toProvenanceAnalysisJobDisplayStatus(shared: AiJobDisplayStatus): ProvenanceAnalysisJobDisplayStatus {
  return shared === "missing" ? "not_analysed" : shared;
}

/**
 * Maps the most recent analyse_provenance ai_jobs row for a claim (or
 * null, if none exists at all) onto exactly one of five job-status
 * states. Delegates the actual state computation to the shared module;
 * only relabels 'missing' -> 'not_analysed' for this operation's callers.
 */
export function computeProvenanceAnalysisJobDisplayStatus(
  job: ProvenanceAnalysisJobForDisplay | null,
  now: Date,
  thresholdMs: number = PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS
): ProvenanceAnalysisJobDisplayStatus {
  return toProvenanceAnalysisJobDisplayStatus(computeAiJobDisplayStatus(job, now, thresholdMs));
}
