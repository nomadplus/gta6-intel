/**
 * Phase 5 PR 4: the genuinely operation-agnostic pure logic extracted out
 * of classificationRecoveryLifecycle.ts (Phase 5 PR 3) -- age/staleness
 * calculation and the five-state display mapping never depended on
 * anything specific to classify_relevance; they only need a job's
 * status/timestamps and a threshold. This module has no I/O, no
 * database, and no idea that classify_relevance or extract_claims exist
 * as concepts -- same "pure, deterministic, injected-clock" shape as
 * src/lib/ingestion/ingestionJobLifecycle.ts and
 * src/lib/ai/aiJobLifecycle.ts.
 *
 * What stays OPERATION-SPECIFIC, deliberately NOT generalized here:
 *   - the staleness threshold constant (classify_relevance and
 *     extract_claims each keep their own, independently tunable, even
 *     though both start at the same 5-minute value)
 *   - the ai_jobs DB queries/mutations that use this logic
 *     (classificationRecovery.ts / extractClaimsRecovery.ts)
 *   - the partial unique concurrency index each operation's own
 *     migration defines
 *   - the domain-specific label each operation's own thin wrapper module
 *     uses for its "no job has ever succeeded yet" state (see
 *     MISSING_STATUS's doc comment below)
 * Coupling any of those together would make two unrelated operations'
 * concurrency/recovery semantics accidentally depend on each other --
 * exactly what migration 0014's own header comment warns against for
 * the SQL side of this same split.
 */

export interface InFlightAiJobSnapshot {
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
 * the only available anchor.
 */
export function aiJobAgeMs(job: InFlightAiJobSnapshot, now: Date): number {
  const referenceInstant = job.status === "running" && job.startedAt ? job.startedAt : job.createdAt;
  return now.getTime() - referenceInstant.getTime();
}

export function isStaleInFlightAiJob(job: InFlightAiJobSnapshot, now: Date, thresholdMs: number): boolean {
  return aiJobAgeMs(job, now) > thresholdMs;
}

/**
 * Operation-neutral display status. `missing` (not `unclassified`,
 * `unextracted`, or any other operation-flavored word) is the shared
 * name for "no job of this operation has ever succeeded for this
 * source item" -- classification's and extraction's own thin wrappers
 * each map this to whatever label makes sense in their own domain (e.g.
 * classification may still present it to admins as "Unclassified";
 * extraction presents it as "Unextracted"), so this shared module never
 * has to know either operation's preferred vocabulary.
 */
export type AiJobDisplayStatus = "missing" | "in_progress" | "stale" | "failed" | "succeeded";

export interface AiJobForDisplay {
  status: "pending" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
}

/**
 * Maps the most recent ai_jobs row for a given operation+source-item
 * pair (or null, if none exists at all) onto exactly one of five states.
 * Never collapses a fresh in-flight job into 'missing' or 'failed' --
 * that distinction is the entire point of this function existing
 * separately from a naive "job === null ? missing : job.status".
 */
export function computeAiJobDisplayStatus(
  job: AiJobForDisplay | null,
  now: Date,
  thresholdMs: number
): AiJobDisplayStatus {
  if (!job) return "missing";
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "failed") return "failed";
  return isStaleInFlightAiJob({ status: job.status, createdAt: job.createdAt, startedAt: job.startedAt }, now, thresholdMs)
    ? "stale"
    : "in_progress";
}
