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
import type { IngestionPipelineResult, IngestionJobOutcome, ReviewMetadata } from "./pipelineTypes";
import {
  prepareIngestionSubmission,
  findOrCreateIngestionJob,
  markJobFetchStarted,
  completeJobFailure,
  completeJobReviewOutcome,
  findCandidateSourceItemsByUrl,
  findHashCoincidenceSourceItemIds,
  findAllCandidateSources,
  type IngestionReviewMetadataPatch,
} from "@/db/mutations/ingestion";

/**
 * Phase 4 PR 7: maps the pipeline's transient `ReviewMetadata` to the
 * subset of fields persisted onto `ingestion_jobs` (migration 0009) --
 * kept as an explicit, named conversion rather than spreading the object
 * inline at each call site, so it's obvious at a glance that `retrievedAt`/
 * `httpStatus`/`contentType` are deliberately NOT persisted here (they
 * either have their own dedicated params on completeJobReviewOutcome, or
 * -- retrievedAt -- are adequately covered by the job's own createdAt/
 * completedAt columns).
 */
function toReviewMetadataPatch(metadata: ReviewMetadata): IngestionReviewMetadataPatch {
  return {
    retrievedUrl: metadata.url,
    canonicalUrl: metadata.canonicalUrl,
    rawContentHash: metadata.rawContentHash,
    extractedTitle: metadata.title,
    extractedAuthor: metadata.author,
    extractedPublishedAt: metadata.publishedAt,
    extractedExcerpt: metadata.excerpt,
  };
}

/**
 * The subset of a claimed ingestion_jobs row that processIngestionJob
 * needs. Deliberately a narrow structural type (not the full Drizzle row
 * type) so both call sites -- the manual flow's freshly-created job and
 * the automated processor's claimed row (src/db/mutations/
 * ingestionProcessor.ts) -- can supply it without depending on each
 * other's shape.
 */
export interface JobToProcess {
  id: number;
  submittedUrl: string;
  normalizedUrl: string;
  /**
   * The job's attempt count as of THIS attempt (i.e. already
   * incremented -- the value beginFetchAttempt / the processor's atomic
   * claim just wrote). Drives retry backoff on failure (Phase 4 PR 9).
   */
  attemptCount: number;
}

/**
 * Runs the fetch -> hash -> dedupe -> source-identity -> classify
 * pipeline for a job that is ALREADY in 'fetching' (attempt_count
 * already incremented for this attempt), and persists the outcome. This
 * is the one function both `submitUrlForIngestion` (the manual,
 * live-admin-request flow) and the automated processor
 * (src/app/api/ingestion/process/route.ts, Phase 4 PR 9) call to
 * actually do the work -- neither duplicates this logic, and this
 * function itself has no opinion about who claimed the job or why.
 *
 * Does NOT call markJobFetchStarted/claim anything -- the caller is
 * responsible for having already transitioned the job to 'fetching'
 * (the manual flow via markJobFetchStarted; the processor via its own
 * atomic claim query), since "how a job got claimed" is exactly the
 * part that legitimately differs between the two callers and needs its
 * own concurrency story in each.
 */
export async function processIngestionJob(job: JobToProcess): Promise<IngestionJobOutcome> {
  const preNormalizedUrl = job.normalizedUrl;
  const fetchResult = await safeFetch(job.submittedUrl);

  if (!fetchResult.ok) {
    const outcome = mapSafeFetchFailureToIngestionOutcome(fetchResult.error);
    await completeJobFailure(job.id, outcome, job.attemptCount, fetchResult.error.retryAfter?.delayMs ?? null);

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
    const failureReason = "The page's own structured data declares it is not accessible for free.";
    await completeJobFailure(job.id, { status: "paywalled", failureReason, resultKind: "failed" }, job.attemptCount);
    return { kind: "failed", jobId: job.id, status: "paywalled", failureReason };
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
    url: fetchResult.finalUrl,
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
      reviewMetadata: toReviewMetadataPatch(reviewMetadata),
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
      reviewMetadata: toReviewMetadataPatch(reviewMetadata),
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
    reviewMetadata: toReviewMetadataPatch(reviewMetadata),
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
 *
 * Steps 2/3 (the actual fetch/classify/complete work) are
 * `processIngestionJob`, above -- shared verbatim with the automated
 * processor (Phase 4 PR 9) so the manual admin-request flow and the
 * background job processor can never drift into duplicated or
 * inconsistent ingestion logic.
 */
export async function submitUrlForIngestion(input: unknown): Promise<IngestionPipelineResult> {
  const { admin, submittedUrl, normalizedUrl: preNormalizedUrl } = await prepareIngestionSubmission(input);

  const jobResult = await findOrCreateIngestionJob({
    submittedUrl,
    normalizedUrl: preNormalizedUrl,
    admin,
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

  return processIngestionJob({
    id: job.id,
    submittedUrl,
    normalizedUrl: preNormalizedUrl,
    attemptCount: job.attemptCount + 1,
  });
}
