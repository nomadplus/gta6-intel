/**
 * Typed result API for the manual ingestion pipeline (Section 17).
 * PR 5's admin UI is expected to switch on `kind` rather than parse
 * strings -- every branch carries exactly the structured fields that
 * branch needs, nothing more.
 */
import type { FailureIngestionStatus } from "./statusMapping";

export interface ReviewMetadata {
  /**
   * The actual retrieved URL (`fetchResult.finalUrl`, post-redirects) --
   * NOT necessarily the same as what the admin originally submitted.
   * PR 5 gap fix: this was missing from PR 4's ReviewMetadata even
   * though `finalizeIngestionConfirmation` requires it as `reviewData.url`
   * to create the `source_items` row. Added here rather than reusing
   * `canonicalUrl` (a distinct, page-declared value that may be absent
   * or point somewhere else entirely) or reconstructing it later, since
   * `finalUrl` only exists transiently inside pipeline.ts's fetch result.
   */
  url: string;
  title: string | null;
  /** Hard-capped, ~500-char-max excerpt -- never full article text (Section 6). */
  excerpt: string | null;
  author: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
  retrievedAt: Date;
  rawContentHash: string;
  httpStatus: number;
  contentType: string;
}

interface BaseResult {
  /** The ingestion_jobs row this result corresponds to. */
  jobId: number;
}

/** Section 2: an in-flight job with the same normalizedUrl already exists; nothing new was created or fetched. */
export interface ExistingInflightResult extends BaseResult {
  kind: "existing_inflight";
  existingJobId: number;
  existingStatus: "queued" | "fetching";
}

/** Section 8: same URL, same content hash as an existing source_items row -- linked, not duplicated. */
export interface DuplicateResult extends BaseResult {
  kind: "duplicate";
  sourceItemId: number;
  matchedOn: "normalizedUrl" | "canonicalUrl";
}

export type NeedsReviewReason =
  /** Section 8: same URL as an existing item, but a different content hash. */
  | "hash_mismatch"
  /** Section 10: fetched hostname didn't match exactly one known source. */
  | "no_source_match"
  | "ambiguous_source_match"
  /** Section 5: HTTP 403 alone is genuinely ambiguous (bot-block, geo-block, or paywall). */
  | "ambiguous_forbidden_response";

export interface NeedsReviewResult extends BaseResult {
  kind: "needs_review";
  reason: NeedsReviewReason;
  /** Present for hash_mismatch/no_source_match/ambiguous_source_match (all follow a successful fetch); null for ambiguous_forbidden_response, where the fetch itself did not succeed. */
  metadata: ReviewMetadata | null;
  candidateSourceItemId?: number;
  candidateSourceIds?: number[];
}

/** Section 10/12: exactly one candidate source proposed, no duplicate, nothing persisted yet -- awaiting explicit admin confirmation. */
export interface ReadyForConfirmationResult extends BaseResult {
  kind: "ready_for_confirmation";
  metadata: ReviewMetadata;
  proposedSourceId: number;
  /** Section 9: same content hash found at an unrelated URL -- surfaced for provenance review, never auto-collapsed. */
  hashCoincidenceSourceItemIds: number[];
}

/** A definitive, terminal non-success classification (policy block, auth wall, paywall, unsupported content, transient/retryable failure, etc). */
export interface FailedResult extends BaseResult {
  kind: "failed";
  status: FailureIngestionStatus;
  failureReason: string;
}

export type IngestionPipelineResult =
  | ExistingInflightResult
  | DuplicateResult
  | NeedsReviewResult
  | ReadyForConfirmationResult
  | FailedResult;

/**
 * The result shape of processing a job that already exists and is
 * already in 'fetching' (Phase 4 PR 9) -- every IngestionPipelineResult
 * kind except `existing_inflight`, which can only ever result from the
 * create-or-reuse decision that happens before a job reaches 'fetching'
 * in the first place (findOrCreateIngestionJob), not from processing one.
 */
export type IngestionJobOutcome = Exclude<IngestionPipelineResult, ExistingInflightResult>;
