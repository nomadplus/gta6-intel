/**
 * Phase 5 PR 3 classify_relevance recovery path -- thin, domain-specific
 * wrapper. As of Phase 5 PR 4, the genuinely operation-agnostic logic
 * (age/staleness calculation, the five-state display mapping) lives in
 * src/lib/ai/aiJobRecoveryLifecycle.ts, shared with extract_claims's own
 * wrapper (extractClaimsRecoveryLifecycle.ts). This file now only adds
 * what IS classification-specific: its own independently-tunable
 * staleness threshold constant, and mapping the shared "missing" state
 * to this operation's own vocabulary ("unclassified"). Every exported
 * name and signature below is unchanged from PR 3 -- existing callers
 * (src/db/mutations/classificationRecovery.ts,
 * src/db/queries/admin/index.ts, src/app/admin/(protected)/review/page.tsx,
 * src/checks/classificationRecoveryLifecycle.check.ts) require no edits.
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs, type AiJobDisplayStatus } from "./aiJobRecoveryLifecycle";

/**
 * Staleness window for an in-flight classify_relevance job. Deliberately
 * its own named constant, not a reuse of ingestion's
 * RECOVERY_STALE_THRESHOLD_MS or extract_claims's own threshold, even
 * though the initial value is the same for all of them -- these are
 * different operational contexts (an ingestion fetch attempt vs. a
 * single AI provider call vs. a different AI provider call) and may
 * need independent tuning later.
 */
export const CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightClassificationJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

export function classificationJobAgeMs(job: InFlightClassificationJobSnapshot, now: Date): number {
  return aiJobAgeMs(job, now);
}

export function isStaleInFlightClassificationJob(
  job: InFlightClassificationJobSnapshot,
  now: Date,
  thresholdMs: number = CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return isStaleInFlightAiJob(job, now, thresholdMs);
}

/**
 * classify_relevance's own vocabulary for the shared 'missing' state --
 * unchanged from PR 3's "unclassified", so every existing caller
 * (notably the admin review page) keeps working without edits.
 */
export type ClassificationDisplayStatus = "unclassified" | "in_progress" | "stale" | "failed" | "succeeded";

export interface ClassificationJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

function toClassificationDisplayStatus(shared: AiJobDisplayStatus): ClassificationDisplayStatus {
  return shared === "missing" ? "unclassified" : shared;
}

/**
 * Maps the most recent classify_relevance ai_jobs row for a source item
 * (or null, if none exists at all) onto exactly one of five admin-facing
 * states. Delegates the actual state computation to the shared module;
 * only relabels 'missing' -> 'unclassified' for this operation's callers.
 */
export function computeClassificationDisplayStatus(
  job: ClassificationJobForDisplay | null,
  now: Date,
  thresholdMs: number = CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS
): ClassificationDisplayStatus {
  return toClassificationDisplayStatus(computeAiJobDisplayStatus(job, now, thresholdMs));
}
