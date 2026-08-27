"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSource, updateSource, createSourceItem, updateSourceItem } from "@/db/mutations/sources";
import { createSourceRelationship, deleteSourceRelationship } from "@/db/mutations/provenance";
import { formDataToObject, safeAction } from "@/lib/actionResult";
import { PROVENANCE_SUBJECT_FIELD } from "@/lib/provenanceDirection";

function errorRedirect(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

export async function createSourceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => createSource(input));
  if (!result.ok) errorRedirect("/admin/sources/new", result.error);
  revalidatePath("/admin/sources");
  redirect(`/admin/sources/${result.data.id}`);
}

export async function updateSourceAction(formData: FormData) {
  const input = formDataToObject(formData);
  const sourceId = input.sourceId as string;
  const result = await safeAction(() => updateSource(input));
  if (!result.ok) errorRedirect(`/admin/sources/${sourceId}`, result.error);
  revalidatePath(`/admin/sources/${sourceId}`);
  redirect(`/admin/sources/${sourceId}?saved=1`);
}

export async function createSourceItemAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => createSourceItem(input));
  if (!result.ok) errorRedirect("/admin/source-items/new", result.error);
  revalidatePath("/admin/source-items");
  redirect(`/admin/source-items/${result.data.id}`);
}

export async function updateSourceItemAction(formData: FormData) {
  const input = formDataToObject(formData);
  const sourceItemId = input.sourceItemId as string;
  const result = await safeAction(() => updateSourceItem(input));
  if (!result.ok) errorRedirect(`/admin/source-items/${sourceItemId}`, result.error);
  revalidatePath(`/admin/source-items/${sourceItemId}`);
  redirect(`/admin/source-items/${sourceItemId}?saved=1`);
}

export async function createSourceRelationshipAction(formData: FormData) {
  const input = formDataToObject(formData);
  // Phase 5 PR 8a: "this item" -- the page we redirect back to -- is now the
  // SUBJECT field. This previously read `input.sourceItemIdB`, matching the
  // old inverted form binding.
  const sourceItemId = input[PROVENANCE_SUBJECT_FIELD] as string;
  const result = await safeAction(() => createSourceRelationship(input));
  if (!result.ok) errorRedirect(`/admin/source-items/${sourceItemId}`, result.error);
  revalidatePath(`/admin/source-items/${sourceItemId}`);
  redirect(`/admin/source-items/${sourceItemId}?saved=relationship`);
}

export async function deleteSourceRelationshipAction(formData: FormData) {
  const relationshipId = Number(formData.get("relationshipId"));
  const sourceItemId = String(formData.get("sourceItemId"));
  const result = await safeAction(() => deleteSourceRelationship(relationshipId));
  if (!result.ok) errorRedirect(`/admin/source-items/${sourceItemId}`, result.error);
  revalidatePath(`/admin/source-items/${sourceItemId}`);
  redirect(`/admin/source-items/${sourceItemId}`);
}
