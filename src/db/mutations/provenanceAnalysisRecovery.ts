import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { buildFailurePatch } from "@/lib/ai/aiJobLifecycle";
import { isStaleInFlightProvenanceAnalysisJob } from "@/lib/ai/provenanceAnalysisRecoveryLifecycle";

/**
 * Phase 5 PR 8b recovery path -- database persistence ONLY, structurally
 * identical to compareClaimsRecovery.ts (Phase 5 PR 7). No AI/provider
 * call happens anywhere in this file.
 *
 * Locking pattern: plain `.for("update")` -- a blocking row lock, NOT
 * `FOR UPDATE SKIP LOCKED`, same reasoning as every sibling recovery
 * mutation: this function targets exactly ONE specific anchor claim,
 * there is nothing to "skip" to. This is also why the known sub-second
 * READ COMMITTED race the PR8b plan explicitly accepts is scoped to the
 * TRIGGER path (triggerAnalyseProvenance), not this recovery path -- this
 * mutation itself is already safely serialized per claim by this lock.
 *
 * requireAdmin() is called here, inside the mutation, matching this
 * codebase's existing convention.
 *
 * No admin_audit_log entries for trigger or recovery actions, matching
 * the PR3/PR4/PR6/PR7 convention -- only the eventual human
 * approve/edit/reject decision on a specific proposed edge is audited.
 */

export type ProvenanceAnalysisReclaimOutcome =
  | { outcome: "reclaimed"; reclaimedJobId: number }
  | { outcome: "fresh_in_flight" }
  | { outcome: "none" };

export async function reclaimStaleInFlightProvenanceAnalysisJob(
  claimId: number,
  now: Date = new Date()
): Promise<ProvenanceAnalysisReclaimOutcome> {
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
      .where(and(eq(aiJobs.operation, "analyse_provenance"), eq(aiJobs.provenanceClaimId, claimId), inArray(aiJobs.status, ["pending", "running"])))
      .for("update");

    if (!job) return { outcome: "none" };

    const status = job.status as "pending" | "running";

    if (!isStaleInFlightProvenanceAnalysisJob({ status, createdAt: job.createdAt, startedAt: job.startedAt }, now)) {
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
