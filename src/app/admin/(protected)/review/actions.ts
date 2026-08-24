"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { reclaimStaleInFlightClassificationJob } from "@/db/mutations/classificationRecovery";
import { triggerClassifyRelevance } from "@/lib/ai/operations/classificationTrigger";
import { reclaimStaleInFlightExtractClaimsJob } from "@/db/mutations/extractClaimsRecovery";
import { triggerExtractClaims } from "@/lib/ai/operations/extractClaimsTrigger";
import { approveClaimProposal, rejectClaimProposal } from "@/db/mutations/claimProposalReviews";
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

/**
 * Phase 5 PR 4 admin action: for a source item whose extract_claims
 * status is "unextracted", "stale", or "failed" (see
 * extractionActionability.ts's canTriggerExtraction -- the same three
 * states, never "in_progress" or "succeeded"), attempts a fresh
 * extraction. Same two-step shape as runClassificationRecoveryAction
 * above, operation swapped:
 *
 *   1. reclaimStaleInFlightExtractClaimsJob (DB-only) -- reclaims a
 *      genuinely stale in-flight job first; a FRESH in-flight job stops
 *      here entirely.
 *   2. triggerExtractClaims (orchestration boundary) -- enforces the
 *      eligibility gate (latest successful classify_relevance result
 *      must be 'relevant') BEFORE any ai_jobs row or provider call; an
 *      ineligible item surfaces as a normal, safe error string via
 *      safeAction, never a crash.
 *
 * Uses its own `extractStatus`/`extractError` query params, distinct from
 * classification's `recoveryStatus`/`recoveryError`, so both sections'
 * banners can be shown independently on the same page load.
 */
export async function runExtractClaimsAction(formData: FormData) {
  const input = formDataToObject(formData);
  const sourceItemId = Number(input.sourceItemId);

  const reclaimOutcome = await safeAction(() => reclaimStaleInFlightExtractClaimsJob(sourceItemId));
  if (!reclaimOutcome.ok) {
    redirect(`/admin/review?extractError=${encodeURIComponent(reclaimOutcome.error)}`);
  }

  revalidatePath("/admin/review");

  if (reclaimOutcome.data.outcome === "fresh_in_flight") {
    redirect(`/admin/review?extractStatus=fresh_in_flight&sourceItemId=${sourceItemId}`);
  }

  const extractOutcome = await safeAction(() => triggerExtractClaims(sourceItemId));
  if (!extractOutcome.ok) {
    // Covers both an unexpected throw AND, notably,
    // SourceItemNotEligibleForExtractionError -- safeAction's catch-all
    // surfaces a plain, deliberately-authored Error's own message
    // directly (see actionResult.ts's findPgError/isRawDatabaseErrorCode
    // handling), so this is never a raw crash even for the eligibility
    // rejection path.
    redirect(`/admin/review?extractError=${encodeURIComponent(extractOutcome.error)}`);
  }

  const result = extractOutcome.data;
  const status = result.ok ? "succeeded" : result.reason;
  redirect(`/admin/review?extractStatus=${status}&sourceItemId=${sourceItemId}`);
}

/**
 * Phase 5 PR 5: these actions only review a candidate already persisted by a
 * successful extract_claims job. They never invoke a model. The mutation
 * itself re-reads the candidate and source provenance from the database, so
 * no hidden form value can substitute an excerpt or source item.
 */
export async function approveClaimProposalAction(formData: FormData) {
  const input = formDataToObject(formData, ["topicIds"]);
  const outcome = await safeAction(() => approveClaimProposal(input));
  if (!outcome.ok) {
    redirect(`/admin/review?proposalError=${encodeURIComponent(outcome.error)}`);
  }
  revalidatePath("/admin/review");
  revalidatePath("/admin/claims");
  redirect(`/admin/review?proposalStatus=approved&claimId=${outcome.data.claim.id}`);
}

export async function rejectClaimProposalAction(formData: FormData) {
  const input = formDataToObject(formData);
  const outcome = await safeAction(() => rejectClaimProposal(input));
  if (!outcome.ok) {
    redirect(`/admin/review?proposalError=${encodeURIComponent(outcome.error)}`);
  }
  revalidatePath("/admin/review");
  redirect("/admin/review?proposalStatus=rejected");
}
