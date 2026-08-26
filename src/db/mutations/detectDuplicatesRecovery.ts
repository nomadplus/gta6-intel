import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { buildFailurePatch } from "@/lib/ai/aiJobLifecycle";
import { isStaleInFlightDetectDuplicatesJob } from "@/lib/ai/detectDuplicatesRecoveryLifecycle";
import { isProposalReviewed } from "@/db/queries/admin";
import { ProposalAlreadyReviewedForDuplicateCheckError } from "@/lib/ai/operations/detectDuplicatesTrigger";

/**
 * Phase 5 PR 6 recovery path -- database persistence ONLY, structurally
 * identical to extractClaimsRecovery.ts (Phase 5 PR 4), operation string
 * swapped and identity narrowed from one sourceItemId to one
 * (extractionAiResultId, extractionCandidateIndex) pair -- see migration
 * 0018's own header for why detect_duplicates cannot reuse the
 * source-item-scoped guard. No AI/provider call happens anywhere in this
 * file.
 *
 * Locking pattern: plain `.for("update")` -- a blocking row lock, NOT
 * `FOR UPDATE SKIP LOCKED`, for the exact same reason
 * extractClaimsRecovery.ts uses it: this function targets exactly ONE
 * specific candidate, there is nothing to "skip" to.
 *
 * requireAdmin() is called here, inside the mutation, matching this
 * codebase's existing convention.
 *
 * The eligibility gate (isProposalReviewed) is checked BEFORE the lock is
 * even acquired -- if this candidate has already been reviewed, recovery
 * must refuse rather than reclaim-then-allow-a-fresh-attempt, per the
 * same "no new check/retry/recovery after review is terminal" rule
 * triggerDetectDuplicates enforces. A job that is genuinely still
 * pending/running when review becomes terminal is left completely
 * alone -- this check only blocks what happens AFTER this function
 * would otherwise act, never touches an existing row by itself.
 */

export type DetectDuplicatesReclaimOutcome =
  | { outcome: "reclaimed"; reclaimedJobId: number }
  | { outcome: "fresh_in_flight" }
  | { outcome: "none" };

export async function reclaimStaleInFlightDetectDuplicatesJob(
  extractionAiResultId: number,
  extractionCandidateIndex: number,
  now: Date = new Date()
): Promise<DetectDuplicatesReclaimOutcome> {
  await requireAdmin("editor");

  if (await isProposalReviewed(adminDb, extractionAiResultId, extractionCandidateIndex)) {
    throw new ProposalAlreadyReviewedForDuplicateCheckError(extractionAiResultId, extractionCandidateIndex);
  }

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
          eq(aiJobs.operation, "detect_duplicates"),
          eq(aiJobs.extractionAiResultId, extractionAiResultId),
          eq(aiJobs.extractionCandidateIndex, extractionCandidateIndex),
          inArray(aiJobs.status, ["pending", "running"])
        )
      )
      .for("update");

    if (!job) return { outcome: "none" };

    const status = job.status as "pending" | "running";

    if (!isStaleInFlightDetectDuplicatesJob({ status, createdAt: job.createdAt, startedAt: job.startedAt }, now)) {
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
