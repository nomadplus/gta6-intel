"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createDiscoveryFeed, updateDiscoveryFeed } from "@/db/mutations/discoveryFeeds";
import { formDataToObject, safeAction } from "@/lib/actionResult";

function errorRedirect(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

export async function createDiscoveryFeedAction(formData: FormData) {
  const input = formDataToObject(formData);
  const result = await safeAction(() => createDiscoveryFeed(input));
  if (!result.ok) errorRedirect("/admin/discovery-feeds/new", result.error);
  revalidatePath("/admin/discovery-feeds");
  redirect(`/admin/discovery-feeds/${result.data.id}`);
}

export async function updateDiscoveryFeedAction(formData: FormData) {
  const input = formDataToObject(formData);
  const feedId = input.feedId as string;
  const result = await safeAction(() => updateDiscoveryFeed(input));
  if (!result.ok) errorRedirect(`/admin/discovery-feeds/${feedId}`, result.error);
  revalidatePath(`/admin/discovery-feeds/${feedId}`);
  revalidatePath("/admin/discovery-feeds");
  redirect(`/admin/discovery-feeds/${feedId}?saved=1`);
}
