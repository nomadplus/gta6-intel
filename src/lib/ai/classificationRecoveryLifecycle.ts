/**
 * Pure decision logic for the Phase 5 PR 3 classify_relevance recovery
 * path -- no I/O, same shape/rationale as
 * src/lib/ingestion/ingestionJobLifecycle.ts (patches) and
 * src/lib/ai/aiJobLifecycle.ts (ai_jobs patches): deterministic,
 * injected-clock functions that are checkable with in-memory objects and
 * no database, kept separate from the actual reads/writes
 * (src/db/mutations/classificationRecovery.ts,
 * src/db/queries/admin/index.ts).
 *
 * Covers two closely related but distinct questions:
 *   1. Is a given in-flight (pending/running) ai_jobs row stale enough to
 *      be reclaimed? (isStaleInFlightClassificationJob)
 *   2. Given the most recent classify_relevance job (if any) for a source
 *      item, what should the admin review UI display?
 *      (computeClassificationDisplayStatus)
 *
 * Both are used by the recovery mutation (to decide whether to
 * terminalize a stale row before attempting a fresh classification) and
 * by the admin query/page (to decide which of five states -- unclassified
 * / in_progress / stale / failed / succeeded -- to render), so a single
 * shared definition of "stale" can never drift between the two.
 */

/**
 * Staleness window for an in-flight classify_relevance job. Deliberately
 * its own named constant, not a reuse of ingestion's
 * RECOVERY_STALE_THRESHOLD_MS, even though the initial value is the
 * same -- these are different operational contexts (an ingestion fetch
 * attempt vs. a single AI provider call) and may need independent tuning
 * later.
 */
export const CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface InFlightClassificationJobSnapshot {
  status: "pending" | "running";
  createdAt: Date;
  /** Null for a 'pending' job that has never begun running. */
  startedAt: Date | null;
}

/**
 * The reference instant for staleness differs by state: a 'running'
 * job's relevant clock is when the provider call actually began
 * (startedAt) -- anchoring on createdAt instead could incorrectly
 * reclaim a legitimately recent provider execution that spent real time
 * sitting 'pending' first (e.g. behind a slow safety check). A 'pending'
 * job has no startedAt yet by definition, so createdAt (queue time) is
 * the only available anchor. Mirrors
 * ingestionJobLifecycle.ts/ingestionProcessor.ts's own stale-'fetching'
 * reclaim, which likewise anchors staleness on the timestamp marking
 * entry into the state actually being evaluated, not job creation time.
 */
export function classificationJobAgeMs(job: InFlightClassificationJobSnapshot, now: Date): number {
  const referenceInstant = job.status === "running" && job.startedAt ? job.startedAt : job.createdAt;
  return now.getTime() - referenceInstant.getTime();
}

export function isStaleInFlightClassificationJob(
  job: InFlightClassificationJobSnapshot,
  now: Date,
  thresholdMs: number = CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS
): boolean {
  return classificationJobAgeMs(job, now) > thresholdMs;
}

export type ClassificationDisplayStatus = "unclassified" | "in_progress" | "stale" | "failed" | "succeeded";

export interface ClassificationJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

/**
 * Maps the most recent classify_relevance ai_jobs row for a source item
 * (or null, if none exists at all) onto exactly one of five admin-facing
 * states. Never collapses a fresh in-flight job into 'unclassified' or
 * 'failed' -- that distinction is the entire point of this function
 * existing separately from a naive "job === null ? missing : job.status".
 */
export function computeClassificationDisplayStatus(
  job: ClassificationJobForDisplay | null,
  now: Date,
  thresholdMs: number = CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS
): ClassificationDisplayStatus {
  if (!job) return "unclassified";
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "failed") return "failed";
  // job.status is 'pending' or 'running' here. Rebuilt as an explicit
  // object (rather than passing `job` through directly) so the narrowed
  // property type actually applies at this call site -- TypeScript
  // narrows `job.status` within this function, but not the declared type
  // of the `job` variable itself when passed whole to another function
  // expecting a narrower interface.
  return isStaleInFlightClassificationJob(
    { status: job.status, createdAt: job.createdAt, startedAt: job.startedAt },
    now,
    thresholdMs
  )
    ? "stale"
    : "in_progress";
}
