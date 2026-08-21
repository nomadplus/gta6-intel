"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { reclaimStaleInFlightClassificationJob } from "@/db/mutations/classificationRecovery";
import { triggerClassifyRelevance } from "@/lib/ai/operations/classificationTrigger";
import { formDataToObject, safeAction } from "@/lib/actionResult";

/**
 * Phase 5 PR 3 admin recovery action: for a source item whose
 * classify_relevance status is "unclassified", "stale", or "failed",
 * attempts a fresh classification. This is a recovery action, not the
 * full PR5 human-review workflow -- no approve/reject/edit/re-analysis
 * decision machinery here, just "try classifying this item again."
 *
 * Two-step shape, per the locked design:
 *   1. reclaimStaleInFlightClassificationJob (DB-only) -- if a genuinely
 *      stale in-flight job exists, terminalize it first. If a FRESH
 *      in-flight job exists, STOP here entirely -- no classification is
 *      attempted, per Clarification 1.
 *   2. triggerClassifyRelevance (orchestration boundary) -- only reached
 *      if step 1 didn't stop early. Its own in-flight uniqueness guard
 *      (ai_jobs_classify_relevance_inflight_unique) is the final, atomic
 *      race-safety backstop against a genuinely concurrent second
 *      recovery click.
 */
export async function runClassificationRecoveryAction(formData: FormData) {
  const input = formDataToObject(formData);
  const sourceItemId = Number(input.sourceItemId);

  const reclaimOutcome = await safeAction(() => reclaimStaleInFlightClassificationJob(sourceItemId));
  if (!reclaimOutcome.ok) {
    redirect(`/admin/review?recoveryError=${encodeURIComponent(reclaimOutcome.error)}`);
  }

  revalidatePath("/admin/review");

  if (reclaimOutcome.data.outcome === "fresh_in_flight") {
    // Clarification 1 (locked): stop immediately. No DB changes beyond
    // what reclaimStaleInFlightClassificationJob's own re-check already
    // did (none, in this branch), and classifyRelevance() is never
    // invoked.
    redirect(`/admin/review?recoveryStatus=fresh_in_flight&sourceItemId=${sourceItemId}`);
  }

  const classifyOutcome = await safeAction(() => triggerClassifyRelevance(sourceItemId));
  if (!classifyOutcome.ok) {
    redirect(`/admin/review?recoveryError=${encodeURIComponent(classifyOutcome.error)}`);
  }

  const result = classifyOutcome.data;
  const status = result.ok ? "succeeded" : result.reason;
  redirect(`/admin/review?recoveryStatus=${status}&sourceItemId=${sourceItemId}`);
}
