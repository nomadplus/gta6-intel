"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { reclaimStaleInFlightClassificationJob } from "@/db/mutations/classificationRecovery";
import { triggerClassifyRelevance } from "@/lib/ai/operations/classificationTrigger";
import { reclaimStaleInFlightExtractClaimsJob } from "@/db/mutations/extractClaimsRecovery";
import { triggerExtractClaims } from "@/lib/ai/operations/extractClaimsTrigger";
import { approveClaimProposal, rejectClaimProposal, resolveProposalAsExistingClaim } from "@/db/mutations/claimProposalReviews";
import { reclaimStaleInFlightDetectDuplicatesJob } from "@/db/mutations/detectDuplicatesRecovery";
import { triggerDetectDuplicates } from "@/lib/ai/operations/detectDuplicatesTrigger";
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
  // Phase 6 hardening: revalidate again HERE, after the mutating call
  // actually completed -- the earlier revalidatePath (above, before
  // triggerClassifyRelevance ran) only reflected pre-mutation state.
  // Redirecting to a URL keyed only on a coarse status word can collide
  // with a URL already visited earlier in the session (e.g. two
  // "failed" retries in a row), so the redirect target also carries the
  // new job's own id -- real identity, not an arbitrary timestamp --
  // guaranteeing this exact URL was never visited before.
  revalidatePath("/admin/review");
  const jobIdParam = result.jobId !== null ? `&jobId=${result.jobId}` : "";
  redirect(`/admin/review?recoveryStatus=${status}&sourceItemId=${sourceItemId}${jobIdParam}`);
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
  // Phase 6 hardening: see runClassificationRecoveryAction's matching
  // comment above -- revalidate again after the mutation actually
  // completed, and key the redirect on the new job's own id rather than
  // risking a URL collision with an earlier identical status word.
  revalidatePath("/admin/review");
  const jobIdParam = result.jobId !== null ? `&jobId=${result.jobId}` : "";
  redirect(`/admin/review?extractStatus=${status}&sourceItemId=${sourceItemId}${jobIdParam}`);
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

/**
 * Phase 5 PR 6: the "Use existing claim" human resolution action.
 * existingClaimId is only ever used by resolveProposalAsExistingClaim as a
 * lookup key -- that mutation re-verifies it against this exact
 * candidate's own latest persisted detect_duplicates result, inside its
 * own transaction, before writing anything. A tampered or stale form
 * value fails there, not here.
 */
export async function resolveAsExistingClaimAction(formData: FormData) {
  const input = formDataToObject(formData);
  const outcome = await safeAction(() => resolveProposalAsExistingClaim(input));
  if (!outcome.ok) {
    redirect(`/admin/review?proposalError=${encodeURIComponent(outcome.error)}`);
  }
  revalidatePath("/admin/review");
  revalidatePath("/admin/claims");
  redirect(`/admin/review?proposalStatus=linked_existing_claim&claimId=${outcome.data.existingClaim.id}`);
}

/**
 * Phase 5 PR 6: same two-step shape as runClassificationRecoveryAction/
 * runExtractClaimsAction above, operation swapped and identity narrowed
 * to one extraction candidate (aiResultId, candidateIndex) instead of one
 * source item:
 *   1. reclaimStaleInFlightDetectDuplicatesJob (DB-only) -- reclaims a
 *      genuinely stale in-flight job first; a FRESH in-flight job stops
 *      here entirely. Also enforces the reviewed-proposal eligibility
 *      gate BEFORE attempting any reclaim.
 *   2. triggerDetectDuplicates (orchestration boundary) -- re-enforces
 *      the same eligibility gate, decides the tiered retrieval strategy,
 *      and short-circuits to a zero-provider-call "no_existing_claims"
 *      outcome when there is nothing yet to compare against.
 *
 * Uses its own `duplicateStatus`/`duplicateError` query params, distinct
 * from classification's/extraction's own, so all three sections' banners
 * can be shown independently on the same page load.
 */
export async function runDetectDuplicatesAction(formData: FormData) {
  const input = formDataToObject(formData);
  const aiResultId = Number(input.aiResultId);
  const candidateIndex = Number(input.candidateIndex);

  const reclaimOutcome = await safeAction(() => reclaimStaleInFlightDetectDuplicatesJob(aiResultId, candidateIndex));
  if (!reclaimOutcome.ok) {
    redirect(`/admin/review?duplicateError=${encodeURIComponent(reclaimOutcome.error)}`);
  }

  revalidatePath("/admin/review");

  if (reclaimOutcome.data.outcome === "fresh_in_flight") {
    redirect(`/admin/review?duplicateStatus=fresh_in_flight&aiResultId=${aiResultId}&candidateIndex=${candidateIndex}`);
  }

  const detectOutcome = await safeAction(() => triggerDetectDuplicates(aiResultId, candidateIndex));
  if (!detectOutcome.ok) {
    redirect(`/admin/review?duplicateError=${encodeURIComponent(detectOutcome.error)}`);
  }

  const outcome = detectOutcome.data;
  const status = outcome.kind === "no_existing_claims" ? "no_existing_claims" : outcome.result.ok ? "succeeded" : outcome.result.reason;
  // Phase 6 hardening: see runClassificationRecoveryAction's matching
  // comment above. "no_existing_claims" never creates an ai_jobs row (no
  // provider call was made), so there is no job id to key on there --
  // the redirect target is left as-is for that one outcome, same as
  // before.
  revalidatePath("/admin/review");
  const jobIdParam = outcome.kind === "ran" && outcome.result.jobId !== null ? `&jobId=${outcome.result.jobId}` : "";
  redirect(`/admin/review?duplicateStatus=${status}&aiResultId=${aiResultId}&candidateIndex=${candidateIndex}${jobIdParam}`);
}
