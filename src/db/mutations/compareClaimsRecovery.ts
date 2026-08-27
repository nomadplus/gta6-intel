import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { buildFailurePatch } from "@/lib/ai/aiJobLifecycle";
import { isStaleInFlightCompareClaimsJob } from "@/lib/ai/compareClaimsRecoveryLifecycle";

/**
 * Phase 5 PR 7 recovery path -- database persistence ONLY, structurally
 * identical to detectDuplicatesRecovery.ts (Phase 5 PR 6), operation
 * string swapped and identity narrowed from one (extraction_ai_result_id,
 * extraction_candidate_index) pair to one comparisonClaimId. No
 * AI/provider call happens anywhere in this file.
 *
 * Locking pattern: plain `.for("update")` -- a blocking row lock, NOT
 * `FOR UPDATE SKIP LOCKED`, for the exact same reason
 * extractClaimsRecovery.ts/detectDuplicatesRecovery.ts use it: this
 * function targets exactly ONE specific focus claim, there is nothing to
 * "skip" to.
 *
 * requireAdmin() is called here, inside the mutation, matching this
 * codebase's existing convention.
 *
 * Unlike detectDuplicatesRecovery.ts, there is no "already reviewed"
 * eligibility gate to re-check here -- compare_claims has no per-focus-
 * claim reviewed/unreviewed state analogous to a single extract_claims
 * candidate's review; the underlying assessments are reviewed
 * individually, and PR7 deliberately provides no re-analysis control
 * from a succeeded state regardless (see
 * relationshipAnalysisActionability.ts), so recovering a stale job for a
 * claim that already has a succeeded result is never in tension with any
 * "reviewed, no further attempts" rule the way PR6's candidate-level gate
 * is.
 *
 * No admin_audit_log entries for trigger or recovery actions, matching
 * the PR3/PR4/PR6 convention -- only the eventual human
 * approve/edit/reject decision on a specific assessment is audited.
 */

export type CompareClaimsReclaimOutcome =
  | { outcome: "reclaimed"; reclaimedJobId: number }
  | { outcome: "fresh_in_flight" }
  | { outcome: "none" };

export async function reclaimStaleInFlightCompareClaimsJob(
  claimId: number,
  now: Date = new Date()
): Promise<CompareClaimsReclaimOutcome> {
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
      .where(and(eq(aiJobs.operation, "compare_claims"), eq(aiJobs.comparisonClaimId, claimId), inArray(aiJobs.status, ["pending", "running"])))
      .for("update");

    if (!job) return { outcome: "none" };

    const status = job.status as "pending" | "running";

    if (!isStaleInFlightCompareClaimsJob({ status, createdAt: job.createdAt, startedAt: job.startedAt }, now)) {
      return { outcome: "fresh_in_flight" };
    }

    await tx
      .update(aiJobs)
      .set(
        buildFailurePatch({
          now,
          error: "stale_recovery_reclaimed: no terminal outcome was recorded within the staleness window; reclaimed by admin recovery action.",
        })
      )
      .where(eq(aiJobs.id, job.id));

    return { outcome: "reclaimed", reclaimedJobId: job.id };
  });
}
