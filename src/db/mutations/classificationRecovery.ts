import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { buildFailurePatch } from "@/lib/ai/aiJobLifecycle";
import { isStaleInFlightClassificationJob } from "@/lib/ai/classificationRecoveryLifecycle";

/**
 * Phase 5 PR 3 recovery path -- database persistence ONLY. No AI/provider
 * call happens anywhere in this file (Section 9/15, and the explicit
 * architecture correction on this PR: don't scatter AI orchestration
 * into the DB mutation layer). This module's one job is: given a source
 * item, determine whether an in-flight classify_relevance job for it is
 * stale, and if so, terminalize it -- so the orchestration layer
 * (src/lib/ai/operations/classificationTrigger.ts, called from
 * src/app/admin/(protected)/review/actions.ts) can safely attempt a
 * fresh classification afterward.
 *
 * requireAdmin() is called here, inside the mutation, matching this
 * codebase's existing convention (e.g. finalizeIngestionConfirmation) of
 * re-checking authorization independently of the route/layout gate. This
 * is an authorization concern, not an AI-orchestration concern, so it
 * stays in the mutation layer.
 */

export type ReclaimOutcome =
  | { outcome: "reclaimed"; reclaimedJobId: number }
  | { outcome: "fresh_in_flight" }
  | { outcome: "none" };

/**
 * Locks and re-reads the CURRENT most-recent in-flight (pending/running)
 * classify_relevance row for a source item -- never trusts what an admin
 * page displayed a moment earlier -- and only terminalizes it if it is
 * STILL pending/running AND still genuinely stale at the moment of the
 * lock:
 *
 *   - No in-flight row at all -> {outcome: "none"} -- nothing to
 *     reclaim; the caller may proceed straight to a fresh classification
 *     attempt.
 *   - An in-flight row exists but is NOT yet stale -> {outcome:
 *     "fresh_in_flight"} -- per the locked design, the caller MUST STOP
 *     here and make no further attempt; this is not "let the unique
 *     index reject it," it's "don't even try."
 *   - An in-flight row exists AND is stale -> terminalize it to 'failed'
 *     with an explicit stale_recovery_reclaimed error, reusing
 *     buildFailurePatch (the exact same patch shape every other ai_jobs
 *     failure path uses -- including its completedAt timestamp, so a
 *     reclaimed row is never left with no terminal timestamp) rather
 *     than a hand-rolled, subtly different definition of "failed". The
 *     row's id, createdAt, and all other historical fields are otherwise
 *     completely untouched -- it is never deleted, and remains as
 *     permanent historical evidence of the abandoned attempt. Returns
 *     {outcome: "reclaimed", reclaimedJobId} so the caller can proceed to
 *     a fresh attempt.
 *
 * A row already resolved by a concurrent caller between the admin page's
 * last read and this call (moved to succeeded/failed by the original
 * attempt actually completing, or already reclaimed and superseded by
 * another concurrent recovery click) is simply not returned by the
 * WHERE clause below on the second caller's re-check -- this function
 * never overwrites another caller's outcome.
 */
export async function reclaimStaleInFlightClassificationJob(
  sourceItemId: number,
  now: Date = new Date()
): Promise<ReclaimOutcome> {
  await requireAdmin("editor");

  return adminDb.transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: aiJobs.id,
        status: aiJobs.status,
        createdAt: aiJobs.createdAt,
        startedAt: aiJobs.startedAt,
      })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.operation, "classify_relevance"),
          eq(aiJobs.sourceItemId, sourceItemId),
          inArray(aiJobs.status, ["pending", "running"])
        )
      )
      .for("update");

    if (!job) return { outcome: "none" };

    // job.status is narrowed to the enum's full string type by Drizzle,
    // but the WHERE clause above guarantees it's 'pending' or 'running'
    // here -- narrow explicitly rather than trusting that at the type
    // level.
    const status = job.status as "pending" | "running";

    if (!isStaleInFlightClassificationJob({ status, createdAt: job.createdAt, startedAt: job.startedAt }, now)) {
      // Clarification 1 (locked): fresh in-flight means STOP. Do not
      // proceed to attempt a replacement classification and let the
      // unique index reject it -- that index is the final race-safety
      // backstop for genuine concurrent collisions, not a substitute for
      // this known-state check.
      return { outcome: "fresh_in_flight" };
    }

    await tx
      .update(aiJobs)
      .set(
        buildFailurePatch({
          now,
          error:
            "stale_recovery_reclaimed: no terminal outcome was recorded within the staleness window; reclaimed by admin recovery action.",
        })
      )
      .where(eq(aiJobs.id, job.id));

    return { outcome: "reclaimed", reclaimedJobId: job.id };
  });
}
