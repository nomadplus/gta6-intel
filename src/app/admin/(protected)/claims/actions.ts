"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClaim, updateClaimMetadata } from "@/db/mutations/claims";
import { transitionInvestigationStatus, transitionDevelopmentOutcome } from "@/db/mutations/statusTransitions";
import { linkClaimSource, unlinkClaimSource } from "@/db/mutations/claimSources";
import { linkEvidenceToClaim, unlinkEvidenceFromClaim } from "@/db/mutations/evidence";
import { createClaimRelationship, deleteClaimRelationship } from "@/db/mutations/claimRelationships";
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
