import "server-only";
import { safeFetch } from "./safeFetch";
import { normalizeUrl } from "./urlNormalization";
import { extractMetadata } from "./metadataExtraction";
import { computeRawContentHash } from "./contentHash";
import { classifyDuplicateCandidate } from "./duplicateDetection";
import { extractHostname, proposeSourceIdentity } from "./sourceIdentity";
import {
  mapSafeFetchFailureToIngestionOutcome,
  classifySuccessfulFetchForPaywall,
} from "./statusMapping";
import type { IngestionPipelineResult, ReviewMetadata } from "./pipelineTypes";
import {
  prepareIngestionSubmission,
  findOrCreateIngestionJob,
  markJobFetchStarted,
  completeJobFailure,
  completeJobReviewOutcome,
  findCandidateSourceItemsByUrl,
  findHashCoincidenceSourceItemIds,
  findAllCandidateSources,
} from "@/db/mutations/ingestion";

/**
 * Submits a URL for manual ingestion and drives it through to a typed
 * result. This is the ONE function PR 5's admin form is expected to
 * call for "fetch this URL" -- it composes every PR 1-3 foundation
 * piece plus this PR's dedup/source-identity/lifecycle logic, so no
 * ingestion logic needs to be duplicated in the future UI layer.
 *
 * Transaction shape follows Section 13 exactly:
 *   1. short transaction -- redundancy check / job creation
 *      (findOrCreateIngestionJob)
 *   2. external fetch, OUTSIDE any transaction (safeFetch call below)
 *   3. short transaction -- classify/update result (the various
 *      completeJob-prefixed calls, each independently transactional)
 * Finalization/confirmation (step 4, a separate transaction) is
 * `finalizeIngestionConfirmation` in db/mutations/ingestion.ts --
 * deliberately not called from here, since it requires an explicit,
 * separate admin action (Section 12).
 */
export async function submitUrlForIngestion(input: unknown): Promise<IngestionPipelineResult> {
  const { admin, submittedUrl, normalizedUrl: preNormalizedUrl } = await prepareIngestionSubmission(input);

  const jobResult = await findOrCreateIngestionJob({
    submittedUrl,
    normalizedUrl: preNormalizedUrl,
    adminId: admin.id,
  });

  if (jobResult.reused) {
    return {
      kind: "existing_inflight",
      jobId: jobResult.job.id,
      existingJobId: jobResult.job.id,
      existingStatus: jobResult.job.status as "queued" | "fetching",
    };
  }

  const job = jobResult.job;
  await markJobFetchStarted(job.id, job.attemptCount);

  const fetchResult = await safeFetch(submittedUrl);

  if (!fetchResult.ok) {
    const outcome = mapSafeFetchFailureToIngestionOutcome(fetchResult.error);
    await completeJobFailure(job.id, outcome, fetchResult.error.retryAfter?.delayMs ?? null);

    if (outcome.resultKind === "needs_review") {
      // Currently only reachable via the ambiguous 403 case (see
      // statusMapping.ts) -- no metadata exists because the fetch
      // itself never returned a body to extract from.
      return { kind: "needs_review", jobId: job.id, reason: "ambiguous_forbidden_response", metadata: null };
    }
    return { kind: "failed", jobId: job.id, status: outcome.status, failureReason: outcome.failureReason };
  }

  // --- Successful fetch from here on -------------------------------------

  const rawContentHash = computeRawContentHash(fetchResult.bodyText);
  const extracted = extractMetadata(fetchResult.bodyText);

  const paywallStatus = classifySuccessfulFetchForPaywall(extracted.isAccessibleForFree);
  if (paywallStatus) {
    await completeJobFailure(job.id, {
      status: "paywalled",
      failureReason: "The page's own structured data declares it is not accessible for free.",
      resultKind: "failed",
    });
    return {
      kind: "failed",
      jobId: job.id,
      status: "paywalled",
      failureReason: "The page's own structured data declares it is not accessible for free.",
    };
  }

  // Section 8's dedup and Section 10's source-identity matching operate
  // on the normalized form of where the content actually ended up
  // (`finalUrl`, after redirects) -- distinct from `preNormalizedUrl`
  // above, which is necessarily computed from `submittedUrl` before any
  // fetch happens and exists only to drive the in-flight redundancy
  // check. The schema comment on source_items.normalized_url documents
  // it as "normalized form of `url`" -- and `url` will be `finalUrl`,
  // not `submittedUrl`, once/if this item is confirmed (see
  // finalizeIngestionConfirmation). When there is no redirect, the two
  // values are identical; this only matters when they diverge.
  const finalNormalized = normalizeUrl(fetchResult.finalUrl);
  const postNormalizedUrl = finalNormalized.ok ? finalNormalized.normalizedUrl : preNormalizedUrl;

  const reviewMetadata: ReviewMetadata = {
    title: extracted.title,
    excerpt: extracted.excerpt,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
    canonicalUrl: extracted.canonicalUrl,
    retrievedAt: new Date(),
    rawContentHash,
    httpStatus: fetchResult.status,
    contentType: fetchResult.contentType,
  };

  const candidates = await findCandidateSourceItemsByUrl(postNormalizedUrl, extracted.canonicalUrl);
  const dedup = classifyDuplicateCandidate(candidates, postNormalizedUrl, extracted.canonicalUrl, rawContentHash);

  if (dedup.kind === "duplicate") {
    await completeJobReviewOutcome({
      jobId: job.id,
      status: "duplicate",
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      contentLength: fetchResult.byteLength,
      sourceItemId: dedup.sourceItemId,
    });
    return { kind: "duplicate", jobId: job.id, sourceItemId: dedup.sourceItemId, matchedOn: dedup.matchedOn };
  }

  if (dedup.kind === "needs_review") {
    await completeJobReviewOutcome({
      jobId: job.id,
      status: "needs_review",
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      contentLength: fetchResult.byteLength,
      sourceItemId: null,
    });
    return {
      kind: "needs_review",
      jobId: job.id,
      reason: "hash_mismatch",
      metadata: reviewMetadata,
      candidateSourceItemId: dedup.candidateSourceItemId,
    };
  }

  // dedup.kind === "no_candidate" -- proceed to source identity resolution.
  const hostname = extractHostname(fetchResult.finalUrl);
  const candidateSources = await findAllCandidateSources();
  const proposal = hostname ? proposeSourceIdentity(hostname, candidateSources) : { kind: "no_match" as const };
  const hashCoincidenceSourceItemIds = await findHashCoincidenceSourceItemIds(rawContentHash, []);

  if (proposal.kind === "proposed") {
    await completeJobReviewOutcome({
      jobId: job.id,
      status: "needs_review", // see file header: ready_for_confirmation has no distinct stored status
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      contentLength: fetchResult.byteLength,
      sourceItemId: null,
    });
    return {
      kind: "ready_for_confirmation",
      jobId: job.id,
      metadata: reviewMetadata,
      proposedSourceId: proposal.sourceId,
      hashCoincidenceSourceItemIds,
    };
  }

  await completeJobReviewOutcome({
    jobId: job.id,
    status: "needs_review",
    httpStatus: fetchResult.status,
    contentType: fetchResult.contentType,
    contentLength: fetchResult.byteLength,
    sourceItemId: null,
  });

  if (proposal.kind === "ambiguous") {
    return {
      kind: "needs_review",
      jobId: job.id,
      reason: "ambiguous_source_match",
      metadata: reviewMetadata,
      candidateSourceIds: proposal.matchedSourceIds,
    };
  }

  return { kind: "needs_review", jobId: job.id, reason: "no_source_match", metadata: reviewMetadata };
}
