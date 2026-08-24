/**
 * Phase 5 PR 4 extract_claims recovery path -- thin, domain-specific
 * wrapper over the shared, operation-agnostic logic in
 * src/lib/ai/aiJobRecoveryLifecycle.ts. Structurally identical to
 * classificationRecoveryLifecycle.ts's own wrapper (both wrap the same
 * shared module), but deliberately its own file with its own threshold
 * constant and its own vocabulary for the shared 'missing' state --
 * see aiJobRecoveryLifecycle.ts's header for why these two operations'
 * thresholds/labels are not merged into one.
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs, type AiJobDisplayStatus } from "./aiJobRecoveryLifecycle";

/**
 * Staleness window for an in-flight extract_claims job. Starts equal to
 * classify_relevance's own threshold, but is a distinct, independently
 * tunable constant -- extraction is a heavier per-call operation and may
 * warrant a different window once real production latency data exists.
 */
export const EXTRACT_CLAIMS_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightExtractClaimsJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

export function extractClaimsJobAgeMs(job: InFlightExtractClaimsJobSnapshot, now: Date): number {
  return aiJobAgeMs(job, now);
}

export function isStaleInFlightExtractClaimsJob(
  job: InFlightExtractClaimsJobSnapshot,
  now: Date,
  thresholdMs: number = EXTRACT_CLAIMS_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return isStaleInFlightAiJob(job, now, thresholdMs);
}

/**
 * extract_claims's own vocabulary for the shared 'missing' state --
 * "unextracted" (distinct from classification's "unclassified"), since
 * these are presented to admins as separate concepts on the same source
 * item.
 */
export type ExtractionDisplayStatus = "unextracted" | "in_progress" | "stale" | "failed" | "succeeded";

export interface ExtractClaimsJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

function toExtractionDisplayStatus(shared: AiJobDisplayStatus): ExtractionDisplayStatus {
  return shared === "missing" ? "unextracted" : shared;
}

/**
 * Maps the most recent extract_claims ai_jobs row for a source item (or
 * null, if none exists at all) onto exactly one of five admin-facing
 * states. Delegates the actual state computation to the shared module;
 * only relabels 'missing' -> 'unextracted' for this operation's callers.
 */
export function computeExtractionDisplayStatus(
  job: ExtractClaimsJobForDisplay | null,
  now: Date,
  thresholdMs: number = EXTRACT_CLAIMS_RECOVERY_STALE_THRESHOLD_MS
): ExtractionDisplayStatus {
  return toExtractionDisplayStatus(computeAiJobDisplayStatus(job, now, thresholdMs));
}
