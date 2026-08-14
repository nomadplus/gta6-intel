"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { submitUrlForIngestion } from "@/lib/ingestion/pipeline";
import { finalizeIngestionConfirmation } from "@/db/mutations/ingestion";
import { signReviewPayload } from "@/lib/ingestion/reviewPayloadSigning";
import { formDataToObject, safeAction } from "@/lib/actionResult";
import type {
  IngestionPipelineResult,
  ReviewMetadata,
  ExistingInflightResult,
  DuplicateResult,
  NeedsReviewResult,
  ReadyForConfirmationResult,
  FailedResult,
} from "@/lib/ingestion/pipelineTypes";

/**
 * Client-safe mirrors of the pipeline's result types, with `Date` fields
 * converted to ISO strings -- kept as separate, explicit types rather
 * than deriving them from IngestionPipelineResult with mapped/conditional
 * types, so the client component never has to guess whether a given
 * field survived the server action boundary as a real Date or not, and
 * so a future change to pipelineTypes.ts produces a clear type error
 * here rather than a silently-wrong derived type.
 */
export type SerializedReviewMetadata = Omit<ReviewMetadata, "publishedAt" | "retrievedAt"> & {
  publishedAt: string | null;
  retrievedAt: string;
};

export type SerializedNeedsReviewResult = Omit<NeedsReviewResult, "metadata"> & {
  metadata: SerializedReviewMetadata | null;
};

export type SerializedReadyForConfirmationResult = Omit<ReadyForConfirmationResult, "metadata"> & {
  metadata: SerializedReviewMetadata;
};

export type SerializedPipelineResult =
  | ExistingInflightResult
  | DuplicateResult
  | SerializedNeedsReviewResult
  | SerializedReadyForConfirmationResult
  | FailedResult;

function serializeMetadata(metadata: ReviewMetadata): SerializedReviewMetadata {
  return {
    ...metadata,
    publishedAt: metadata.publishedAt ? metadata.publishedAt.toISOString() : null,
    retrievedAt: metadata.retrievedAt.toISOString(),
  };
}

function serializePipelineResult(result: IngestionPipelineResult): SerializedPipelineResult {
  if (result.kind === "ready_for_confirmation") {
    return { ...result, metadata: serializeMetadata(result.metadata) };
  }
  if (result.kind === "needs_review") {
    return { ...result, metadata: result.metadata ? serializeMetadata(result.metadata) : null };
  }
  return result;
}

export type SubmitActionState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "success"; result: SerializedPipelineResult; reviewToken?: string };

export async function submitIngestionAction(
  _prevState: SubmitActionState,
  formData: FormData
): Promise<SubmitActionState> {
  const input = formDataToObject(formData);
  const outcome = await safeAction(() => submitUrlForIngestion(input));
  if (!outcome.ok) return { status: "error", error: outcome.error };

  const result = outcome.data;

  // Only a `ready_for_confirmation` result ever gets a signed token --
  // this is what actually enforces "needs_review stays view-only" at
  // the security layer (see reviewPayloadSigning.ts's file header), not
  // just the UI declining to render a confirm form for it.
  if (result.kind === "ready_for_confirmation") {
    const reviewToken = signReviewPayload({
      jobId: result.jobId,
      url: result.metadata.url,
      canonicalUrl: result.metadata.canonicalUrl,
      excerpt: result.metadata.excerpt,
      rawContentHash: result.metadata.rawContentHash,
    });
    return { status: "success", result: serializePipelineResult(result), reviewToken };
  }

  return { status: "success", result: serializePipelineResult(result) };
}

export type ConfirmActionState = { status: "idle" } | { status: "error"; error: string };

export async function confirmIngestionAction(
  _prevState: ConfirmActionState,
  formData: FormData
): Promise<ConfirmActionState> {
  const input = formDataToObject(formData);
  const outcome = await safeAction(() => finalizeIngestionConfirmation(input));
  if (!outcome.ok) return { status: "error", error: outcome.error };

  revalidatePath("/admin/source-items");
  redirect(`/admin/source-items/${outcome.data.sourceItemId}`);
}
