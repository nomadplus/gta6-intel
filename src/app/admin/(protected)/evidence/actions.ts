"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createEvidence, linkEvidenceToClaim, unlinkEvidenceFromClaim } from "@/db/mutations/evidence";
import { createTopic, renameTopic } from "@/db/mutations/topics";
import { formDataToObject, safeAction } from "@/lib/actionResult";

function errorRedirect(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

export async function createEvidenceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => createEvidence(input));
  if (!result.ok) errorRedirect("/admin/evidence/new", result.error);
  revalidatePath("/admin/evidence");
  redirect(`/admin/evidence/${result.data.id}`);
}

export async function linkEvidenceToClaimFromEvidenceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const evidenceId = input.evidenceId as string;
  const result = await safeAction(() => linkEvidenceToClaim(input));
  if (!result.ok) errorRedirect(`/admin/evidence/${evidenceId}`, result.error);
  revalidatePath(`/admin/evidence/${evidenceId}`);
  redirect(`/admin/evidence/${evidenceId}?saved=1`);
}

export async function unlinkEvidenceFromEvidencePageAction(formData: FormData) {
  const linkId = Number(formData.get("linkId"));
  const evidenceId = String(formData.get("evidenceId"));
  const result = await safeAction(() => unlinkEvidenceFromClaim(linkId));
  if (!result.ok) errorRedirect(`/admin/evidence/${evidenceId}`, result.error);
  revalidatePath(`/admin/evidence/${evidenceId}`);
  redirect(`/admin/evidence/${evidenceId}`);
}

export async function createTopicAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => createTopic(input));
  if (!result.ok) errorRedirect("/admin/topics", result.error);
  revalidatePath("/admin/topics");
  redirect("/admin/topics?saved=1");
}

export async function renameTopicAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => renameTopic(input));
  if (!result.ok) errorRedirect("/admin/topics", result.error);
  revalidatePath("/admin/topics");
  redirect("/admin/topics?saved=1");
}
