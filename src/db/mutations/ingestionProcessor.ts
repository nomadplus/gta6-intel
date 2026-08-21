import "server-only";
import { and, asc, eq, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { ingestionJobs } from "@/db/schema";
import {
  RECOVERY_STALE_THRESHOLD_MS,
  MAX_INGESTION_ATTEMPTS,
  reclaimStaleFetchingJob,
} from "@/lib/ingestion/ingestionJobLifecycle";

/**
 * Phase 4 PR 9: atomic job selection for the automated ingestion
 * processor (src/app/api/ingestion/process/route.ts). Deliberately
 * separate from src/db/mutations/ingestion.ts, which is the manual,
 * admin-request-driven mutation surface -- this file's two functions are
 * the only things in the codebase allowed to move a job into 'fetching'
 * without a preceding requireAdmin() call, so keeping them in their own
 * module makes that boundary easy to audit.
 *
 * Both functions use `FOR UPDATE SKIP LOCKED`, the standard Postgres
 * primitive for safe concurrent queue claiming: if two processor
 * invocations somehow overlap (e.g. a slow run still going when the next
 * scheduled trigger fires, or a manual on-demand trigger overlapping the
 * cron), a row already locked by one transaction is simply skipped by
 * the other, rather than both processing the same job.
 */

// ---------------------------------------------------------------------------
// Phase A: stale 'fetching' reclaim
// ---------------------------------------------------------------------------

/**
 * Safety valve on how many stale jobs one invocation will reclaim.
 * Reclaiming is cheap (a single status flip per row), so this is
 * generous headroom against an unbounded burst of locked rows in one
 * transaction, not a tuned product limit -- at this project's current
 * scale, the realistic number of simultaneously-stale jobs is close to
 * zero.
 */
const MAX_STALE_RECLAIM_PER_RUN = 50;

export interface ReclaimedStaleJobSummary {
  jobId: number;
  attemptCount: number;
  nextRetryAt: Date | null;
}

/**
 * Finds jobs stuck in 'fetching' past RECOVERY_STALE_THRESHOLD_MS (the
 * process that started them died before it could record any outcome)
 * and moves each to 'fetch_failed' -- scheduling a fresh retry if
 * attempts remain, or leaving it permanently terminal if
 * MAX_INGESTION_ATTEMPTS is already reached. See
 * reclaimStaleFetchingJob's doc comment (ingestionJobLifecycle.ts) for
 * why this is the same "fetch_failed, maybe-retryable" shape as any
 * other transient failure, just discovered by staleness.
 *
 * Runs as its own short transaction, and deliberately BEFORE
 * claimEligibleIngestionJobsForProcessing in the same invocation (see
 * that function's caller in the route handler) -- a job reclaimed here
 * always gets a future nextRetryAt (backoff is never zero), so it can
 * never be immediately re-claimed later in the same run. That decouples
 * "decide this job is abandoned" from "start a new attempt on it" by at
 * least one backoff interval, which matters if the stale threshold ever
 * turns out to be a little aggressive relative to a genuinely slow (but
 * still alive) original attempt.
 */
export async function reclaimStaleFetchingJobs(now: Date = new Date()): Promise<ReclaimedStaleJobSummary[]> {
  const staleCutoff = new Date(now.getTime() - RECOVERY_STALE_THRESHOLD_MS);

  return adminDb.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: ingestionJobs.id, attemptCount: ingestionJobs.attemptCount })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.status, "fetching"), lt(ingestionJobs.startedAt, staleCutoff)))
      .limit(MAX_STALE_RECLAIM_PER_RUN)
      .for("update", { skipLocked: true });

    const summaries: ReclaimedStaleJobSummary[] = [];
    for (const candidate of candidates) {
      const patch = reclaimStaleFetchingJob(candidate.attemptCount, now);
      await tx.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, candidate.id));
      summaries.push({ jobId: candidate.id, attemptCount: candidate.attemptCount, nextRetryAt: patch.nextRetryAt });
    }
    return summaries;
  });
}

// ---------------------------------------------------------------------------
// Phase B: claim eligible jobs for processing
// ---------------------------------------------------------------------------

/** Conservative default, chosen against the 300s Fluid Compute function budget (see route.ts). */
export const DEFAULT_PROCESSOR_BATCH_SIZE = 5;

export interface ClaimedIngestionJob {
  id: number;
  submittedUrl: string;
  normalizedUrl: string;
  /** Already incremented -- reflects THIS claim's attempt, not the prior one. */
  attemptCount: number;
}

/**
 * Atomically claims up to `batchSize` jobs eligible for automated
 * (re)processing, transitioning each to 'fetching' with attempt_count
 * incremented -- the same shape ingestionJobLifecycle.ts's
 * beginFetchAttempt produces for the manual flow, just performed here as
 * part of the claim itself (there is no live admin request to call
 * markJobFetchStarted separately, and folding it into one atomic
 * UPDATE is what makes the claim itself the concurrency boundary).
 *
 * A job is eligible if EITHER:
 *   - status = 'queued' and it has sat that way past
 *     RECOVERY_STALE_THRESHOLD_MS (today, only reachable via a request
 *     that crashed between job creation and the fetch actually
 *     starting; PR 10's future feed-driven job creation will also land
 *     in 'queued' and become eligible the same way, with no change
 *     needed here), OR
 *   - status is 'fetch_failed' or 'rate_limited', its next_retry_at has
 *     passed, and attempt_count has not reached MAX_INGESTION_ATTEMPTS.
 *
 * Ordered oldest-created-first so a backlog drains in a fair,
 * predictable order rather than newest-first.
 */
export async function claimEligibleIngestionJobsForProcessing(
  now: Date = new Date(),
  batchSize: number = DEFAULT_PROCESSOR_BATCH_SIZE
): Promise<ClaimedIngestionJob[]> {
  const stuckQueuedCutoff = new Date(now.getTime() - RECOVERY_STALE_THRESHOLD_MS);

  return adminDb.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: ingestionJobs.id, attemptCount: ingestionJobs.attemptCount })
      .from(ingestionJobs)
      .where(
        or(
          and(eq(ingestionJobs.status, "queued"), lt(ingestionJobs.createdAt, stuckQueuedCutoff)),
          and(
            inArray(ingestionJobs.status, ["fetch_failed", "rate_limited"]),
            isNotNull(ingestionJobs.nextRetryAt),
            lte(ingestionJobs.nextRetryAt, now),
            lt(ingestionJobs.attemptCount, MAX_INGESTION_ATTEMPTS)
          )
        )
      )
      .orderBy(asc(ingestionJobs.createdAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const claimed: ClaimedIngestionJob[] = [];
    for (const candidate of candidates) {
      const [row] = await tx
        .update(ingestionJobs)
        .set({ status: "fetching", startedAt: now, attemptCount: candidate.attemptCount + 1 })
        .where(eq(ingestionJobs.id, candidate.id))
        .returning({
          id: ingestionJobs.id,
          submittedUrl: ingestionJobs.submittedUrl,
          normalizedUrl: ingestionJobs.normalizedUrl,
          attemptCount: ingestionJobs.attemptCount,
        });
      if (row) claimed.push(row);
    }
    return claimed;
  });
}
