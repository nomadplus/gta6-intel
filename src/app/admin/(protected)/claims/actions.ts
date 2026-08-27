"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClaim, updateClaimMetadata } from "@/db/mutations/claims";
import { transitionInvestigationStatus, transitionDevelopmentOutcome } from "@/db/mutations/statusTransitions";
import { linkClaimSource, unlinkClaimSource } from "@/db/mutations/claimSources";
import { linkEvidenceToClaim, unlinkEvidenceFromClaim } from "@/db/mutations/evidence";
import { createClaimRelationship, deleteClaimRelationship } from "@/db/mutations/claimRelationships";
import { reclaimStaleInFlightCompareClaimsJob } from "@/db/mutations/compareClaimsRecovery";
import { triggerCompareClaims } from "@/lib/ai/operations/compareClaimsTrigger";
import { approveClaimComparison, approveClaimComparisonWithChanges, rejectClaimComparison } from "@/db/mutations/claimComparisonReviews";
import { reclaimStaleInFlightProvenanceAnalysisJob } from "@/db/mutations/provenanceAnalysisRecovery";
import { triggerAnalyseProvenance } from "@/lib/ai/operations/analyseProvenanceTrigger";
import {
  approveSourceRelationshipReview,
  approveSourceRelationshipReviewWithChanges,
  rejectSourceRelationshipReview,
} from "@/db/mutations/sourceRelationshipReviews";
import { formDataToObject, safeAction } from "@/lib/actionResult";

function errorRedirect(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

export async function createClaimAction(formData: FormData) {
  const input = formDataToObject(formData, ["topicIds"]);
  const result = await safeAction(() => createClaim(input));
  if (!result.ok) errorRedirect("/admin/claims/new", result.error);
  revalidatePath("/admin/claims");
  redirect(`/admin/claims/${result.data.id}`);
}

export async function updateClaimMetadataAction(formData: FormData) {
  const input = formDataToObject(formData, ["topicIds"]);
  const claimId = input.claimId as string;
  const result = await safeAction(() => updateClaimMetadata(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  revalidatePath("/admin/claims");
  redirect(`/admin/claims/${claimId}?saved=metadata`);
}

export async function transitionInvestigationStatusAction(formData: FormData) {
  const input = formDataToObject(formData, ["evidenceIds"]);
  const claimId = input.claimId as string;
  const result = await safeAction(() => transitionInvestigationStatus(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?saved=investigation`);
}

export async function transitionDevelopmentOutcomeAction(formData: FormData) {
  const input = formDataToObject(formData, ["evidenceIds"]);
  const claimId = input.claimId as string;
  const result = await safeAction(() => transitionDevelopmentOutcome(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?saved=outcome`);
}

export async function linkClaimSourceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = input.claimId as string;
  const result = await safeAction(() => linkClaimSource(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?saved=source`);
}

export async function unlinkClaimSourceAction(formData: FormData) {
  const linkId = Number(formData.get("linkId"));
  const claimId = String(formData.get("claimId"));
  const result = await safeAction(() => unlinkClaimSource(linkId));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}`);
}

export async function linkEvidenceToClaimAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = input.claimId as string;
  const result = await safeAction(() => linkEvidenceToClaim(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?saved=evidence`);
}

export async function unlinkEvidenceFromClaimAction(formData: FormData) {
  const linkId = Number(formData.get("linkId"));
  const claimId = String(formData.get("claimId"));
  const result = await safeAction(() => unlinkEvidenceFromClaim(linkId));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}`);
}

export async function createClaimRelationshipAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = input.claimIdA as string;
  const result = await safeAction(() => createClaimRelationship(input));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?saved=relationship`);
}

export async function deleteClaimRelationshipAction(formData: FormData) {
  const relationshipId = Number(formData.get("relationshipId"));
  const claimId = String(formData.get("claimId"));
  const result = await safeAction(() => deleteClaimRelationship(relationshipId));
  if (!result.ok) errorRedirect(`/admin/claims/${claimId}`, result.error);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}`);
}

/**
 * Phase 5 PR 7: same two-step shape as review/actions.ts's
 * runDetectDuplicatesAction, operation swapped and identity narrowed to
 * one existing focus claim instead of one extraction candidate:
 *   1. reclaimStaleInFlightCompareClaimsJob (DB-only) -- reclaims a
 *      genuinely stale in-flight job first; a FRESH in-flight job stops
 *      here entirely.
 *   2. triggerCompareClaims (orchestration boundary) -- loads the focus
 *      claim, decides the tiered shortlist strategy, and short-circuits
 *      to a zero-provider-call "no_comparable_claims" outcome when there
 *      is nothing yet to compare against.
 *
 * Redirects back to the claim's own detail page (PR7's UI location,
 * unlike PR3/PR4/PR6 which redirect to the shared /admin/review list),
 * with its own `comparisonStatus`/`comparisonError` query params.
 */
export async function runCompareClaimsAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = Number(input.claimId);

  const reclaimOutcome = await safeAction(() => reclaimStaleInFlightCompareClaimsJob(claimId));
  if (!reclaimOutcome.ok) {
    redirect(`/admin/claims/${claimId}?comparisonError=${encodeURIComponent(reclaimOutcome.error)}`);
  }

  revalidatePath(`/admin/claims/${claimId}`);

  if (reclaimOutcome.data.outcome === "fresh_in_flight") {
    redirect(`/admin/claims/${claimId}?comparisonStatus=fresh_in_flight`);
  }

  const compareOutcome = await safeAction(() => triggerCompareClaims(claimId));
  if (!compareOutcome.ok) {
    redirect(`/admin/claims/${claimId}?comparisonError=${encodeURIComponent(compareOutcome.error)}`);
  }

  const outcome = compareOutcome.data;
  const status = outcome.kind === "no_comparable_claims" ? "no_comparable_claims" : outcome.result.ok ? "succeeded" : outcome.result.reason;
  redirect(`/admin/claims/${claimId}?comparisonStatus=${status}`);
}

/**
 * Phase 5 PR 7: these three actions only review an assessment already
 * persisted by a successful compare_claims job. They never invoke a
 * model. The mutation itself re-reads the assessment from the database
 * (getComparisonAssessment), so no hidden form value can substitute a
 * relationship type, direction, confidence, or reasoning -- only
 * otherClaimId is taken from the form, and purely as a tamper-check
 * lookup key.
 */
export async function approveClaimComparisonAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => approveClaimComparison(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?comparisonReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?comparisonReviewStatus=approved`);
}

export async function approveClaimComparisonWithChangesAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => approveClaimComparisonWithChanges(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?comparisonReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?comparisonReviewStatus=edited`);
}

export async function rejectClaimComparisonAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => rejectClaimComparison(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?comparisonReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?comparisonReviewStatus=rejected`);
}

/**
 * Phase 5 PR 8b: same two-step shape as runCompareClaimsAction, operation
 * swapped and identity narrowed to one claim's linked source-item cluster
 * instead of one focus-claim comparison shortlist:
 *   1. reclaimStaleInFlightProvenanceAnalysisJob (DB-only) -- reclaims a
 *      genuinely stale in-flight job first; a FRESH in-flight job stops
 *      here entirely.
 *   2. triggerAnalyseProvenance (orchestration boundary) -- loads the
 *      anchor claim, loads its cluster, and short-circuits to a
 *      zero-provider-call "no_analysable_cluster" outcome when the
 *      cluster has 0 or 1 items.
 *
 * Redirects back to the claim's own detail page with its own
 * `provenanceStatus`/`provenanceError` query params, mirroring PR7's
 * `comparisonStatus`/`comparisonError` exactly. This one action serves
 * ALL FOUR triggerable states (analyse/recover/retry/reanalyse) -- the
 * UI only ever renders the button when
 * canTriggerProvenanceAnalysis()/provenanceAnalysisAction() say it should,
 * so this action needs no separate "reanalyse" entry point.
 */
export async function runAnalyseProvenanceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = Number(input.claimId);

  const reclaimOutcome = await safeAction(() => reclaimStaleInFlightProvenanceAnalysisJob(claimId));
  if (!reclaimOutcome.ok) {
    redirect(`/admin/claims/${claimId}?provenanceError=${encodeURIComponent(reclaimOutcome.error)}`);
  }

  revalidatePath(`/admin/claims/${claimId}`);

  if (reclaimOutcome.data.outcome === "fresh_in_flight") {
    redirect(`/admin/claims/${claimId}?provenanceStatus=fresh_in_flight`);
  }

  const analyseOutcome = await safeAction(() => triggerAnalyseProvenance(claimId));
  if (!analyseOutcome.ok) {
    redirect(`/admin/claims/${claimId}?provenanceError=${encodeURIComponent(analyseOutcome.error)}`);
  }

  const outcome = analyseOutcome.data;
  const status = outcome.kind === "no_analysable_cluster" ? "no_analysable_cluster" : outcome.result.ok ? "succeeded" : outcome.result.reason;
  redirect(`/admin/claims/${claimId}?provenanceStatus=${status}`);
}

/**
 * Phase 5 PR 8b: these three actions only review an edge already
 * persisted by a successful analyse_provenance job. They never invoke a
 * model. The mutation itself re-reads the edge from the database
 * (getProvenanceEdgeAssessment) and re-checks supersession
 * server-side -- no hidden form value can substitute a relationship type,
 * basis, confidence, or reasoning, and a stale page cannot approve an
 * edge that a newer analysis has since superseded.
 */
export async function approveSourceRelationshipReviewAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => approveSourceRelationshipReview(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?provenanceReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?provenanceReviewStatus=approved`);
}

export async function approveSourceRelationshipReviewWithChangesAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => approveSourceRelationshipReviewWithChanges(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?provenanceReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?provenanceReviewStatus=edited`);
}

export async function rejectSourceRelationshipReviewAction(formData: FormData) {
  const input = formDataToObject(formData);
  const claimId = String(formData.get("claimId"));
  const outcome = await safeAction(() => rejectSourceRelationshipReview(input));
  if (!outcome.ok) redirect(`/admin/claims/${claimId}?provenanceReviewError=${encodeURIComponent(outcome.error)}`);
  revalidatePath(`/admin/claims/${claimId}`);
  redirect(`/admin/claims/${claimId}?provenanceReviewStatus=rejected`);
}
