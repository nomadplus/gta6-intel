import "server-only";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { ingestionJobs, discoveryProviders, sourceItems, sources, sourceItemLinks } from "@/db/schema";
import { requireAdmin, type AuthorizedAdmin } from "@/lib/auth/requireAdmin";
import { submitIngestionUrlSchema, confirmIngestionSchema } from "@/lib/validation/adminSchemas";
import { normalizeUrl } from "@/lib/ingestion/urlNormalization";
import { verifyReviewPayload, signReviewPayload } from "@/lib/ingestion/reviewPayloadSigning";
import { logAdminAction } from "./shared";
import {
  findReusableInflightJob,
  beginFetchAttempt,
  completeWithOutcome,
  completeWithFailure,
  type InflightJobCandidate,
} from "@/lib/ingestion/ingestionJobLifecycle";
import type { CandidateSourceItem } from "@/lib/ingestion/duplicateDetection";
import type { CandidateSource } from "@/lib/ingestion/sourceIdentity";
import type { IngestionFailureOutcome } from "@/lib/ingestion/statusMapping";
import type { ExtractedLink } from "@/lib/ingestion/linkExtraction";

/**
 * NOTE on admin_audit_log (updated in Phase 4 PR 6): the `ingestion_job`
 * gap flagged during PR 4 planning is now closed (migration 0008). Audit
 * logging here is deliberately scoped to the two points that are an
 * actual admin-initiated action -- creating a new job (the submit click)
 * and confirming one (the confirm click) -- not every intermediate
 * pipeline-driven status write in between (markJobFetchStarted,
 * completeJobFailure, completeJobReviewOutcome). Those intermediate
 * writes are automatic consequences of the one submit click that already
 * produced an audit entry, not separate admin decisions, so logging them
 * too would just be noise on top of the entry that already covers that
 * click. `ingestion_jobs.admin_user_id`/`created_at`/`completed_at`
 * remain the thinner, mutable-in-place record of who/when for those
 * intermediate states.
 */

// ---------------------------------------------------------------------------
// Submission preparation
// ---------------------------------------------------------------------------

export class InvalidSubmissionUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubmissionUrlError";
  }
}

/**
 * Validates and normalizes a manual submission. Throws (rather than
 * creating any row) if the URL doesn't even parse -- `ingestion_jobs`
 * requires a non-null `normalized_url`, so there is no partial job to
 * create for input that fails at this stage; the caller (a future
 * admin form) treats this as an ordinary form-validation error.
 */
export async function prepareIngestionSubmission(
  input: unknown
): Promise<{ admin: AuthorizedAdmin; submittedUrl: string; normalizedUrl: string }> {
  const admin = await requireAdmin("editor");
  const data = submitIngestionUrlSchema.parse(input);

  const normalized = normalizeUrl(data.url);
  if (!normalized.ok) {
    throw new InvalidSubmissionUrlError(normalized.error.message);
  }

  return { admin, submittedUrl: data.url, normalizedUrl: normalized.normalizedUrl };
}

// ---------------------------------------------------------------------------
// In-flight redundancy + job creation (Section 2/3, short transaction)
// ---------------------------------------------------------------------------

export type IngestionJobRow = typeof ingestionJobs.$inferSelect;

let cachedManualProviderId: number | null = null;

/** `discovery_providers` is tiny, seeded, effectively-static reference data -- caching its id for the current process avoids a repeat lookup on every submission. */
async function getManualDiscoveryProviderId(): Promise<number> {
  if (cachedManualProviderId !== null) return cachedManualProviderId;
  const [row] = await adminDb
    .select({ id: discoveryProviders.id })
    .from(discoveryProviders)
    .where(eq(discoveryProviders.slug, "manual"))
    .limit(1);
  if (!row) {
    throw new Error(
      "The 'manual' discovery provider is not seeded -- this is a data integrity problem, not a user error."
    );
  }
  cachedManualProviderId = row.id;
  return row.id;
}

export type FindOrCreateJobResult =
  | { reused: true; job: IngestionJobRow }
  | { reused: false; job: IngestionJobRow };

/**
 * Section 2: checks for a reusable in-flight job before creating a new
 * one, and Section 13: this is its own short transaction, separate from
 * the (slow, external) fetch that follows outside of it.
 */
export async function findOrCreateIngestionJob(params: {
  submittedUrl: string;
  normalizedUrl: string;
  admin: AuthorizedAdmin;
}): Promise<FindOrCreateJobResult> {
  const manualProviderId = await getManualDiscoveryProviderId();

  return adminDb.transaction(async (tx) => {
    const candidateRows = await tx
      .select({ id: ingestionJobs.id, status: ingestionJobs.status, createdAt: ingestionJobs.createdAt })
      .from(ingestionJobs)
      .where(
        and(
          eq(ingestionJobs.normalizedUrl, params.normalizedUrl),
          inArray(ingestionJobs.status, ["queued", "fetching"])
        )
      );

    const candidates: InflightJobCandidate[] = candidateRows.map((row) => ({
      id: row.id,
      status: row.status as "queued" | "fetching",
      createdAt: row.createdAt,
    }));

    const reusable = findReusableInflightJob(candidates, new Date());
    if (reusable) {
      const [job] = await tx.select().from(ingestionJobs).where(eq(ingestionJobs.id, reusable.id)).limit(1);
      // Deliberately NOT logged -- reusing an in-flight job is not a new
      // admin action, it's this same click being deduplicated against one
      // that already has (or will have) its own creation log entry.
      return { reused: true, job: job! };
    }

    const [job] = await tx
      .insert(ingestionJobs)
      .values({
        submittedUrl: params.submittedUrl,
        normalizedUrl: params.normalizedUrl,
        discoveryProviderId: manualProviderId,
        initiatedBy: "human",
        adminUserId: params.admin.id,
        status: "queued",
      })
      .returning();

    await logAdminAction(tx, params.admin, {
      action: "create",
      entityType: "ingestion_job",
      entityId: job!.id,
      summary: `Submitted URL for ingestion: ${params.submittedUrl}`,
    });

    return { reused: false, job: job! };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (each its own short transaction, per Section 13)
// ---------------------------------------------------------------------------

/** Section 3: marks the fetch as actually starting -- called immediately before invoking safeFetch. */
export async function markJobFetchStarted(jobId: number, previousAttemptCount: number): Promise<void> {
  const patch = beginFetchAttempt(previousAttemptCount, new Date());
  await adminDb.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, jobId));
}

/**
 * A definitive non-success outcome (Section 4/13). `attemptCount` must be
 * the job's attempt count as of this failure (i.e. after the attempt
 * that just failed was counted) -- it drives both retry-eligibility and
 * backoff (Phase 4 PR 9, ingestionJobLifecycle.ts's completeWithFailure).
 */
export async function completeJobFailure(
  jobId: number,
  outcome: IngestionFailureOutcome,
  attemptCount: number,
  retryAfterDelayMs?: number | null
): Promise<void> {
  const patch = completeWithFailure({
    status: outcome.status,
    now: new Date(),
    failureReason: outcome.failureReason,
    attemptCount,
    retryAfterDelayMs,
  });
  await adminDb.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, jobId));
}

/**
 * Persisted review metadata for a `needs_review` outcome (Phase 4 PR 7,
 * migration 0009) -- the same fields the pipeline already extracts into its
 * transient `ReviewMetadata`, kept here as a distinct, narrower type since
 * `completeJobReviewOutcome` is the one place that writes them to the row,
 * and `duplicate` outcomes never need them (Section 8: a duplicate is
 * already linked to its existing source_items row, nothing further to
 * recover). Deliberately omits httpStatus/contentType, since those already
 * have their own dedicated columns/params here.
 */
export interface IngestionReviewMetadataPatch {
  retrievedUrl: string;
  canonicalUrl: string | null;
  rawContentHash: string;
  extractedTitle: string | null;
  extractedAuthor: string | null;
  extractedPublishedAt: Date | null;
  extractedExcerpt: string | null;
  /**
   * Phase 6 prerequisite (migration 0027): this fetch's already-bounded
   * extracted links (see linkExtraction.ts), staged until
   * finalizeIngestionConfirmation promotes them into durable
   * source_item_links rows. Stored as plain JSON-serializable objects --
   * ExtractedLink itself is already just strings/numbers/booleans/null.
   */
  extractedLinksStaging: ExtractedLink[];
}

/**
 * A successful fetch that resolved to `duplicate` or `needs_review`
 * (Section 8) -- no source_items row is created for either. `reviewMetadata`
 * is required for `needs_review` (Phase 4 PR 7: this is what makes the job
 * recoverable from /admin/ingest/history later -- see this file's header
 * comment on ingestion_job audit logging, and reviewPayloadSigning.ts's
 * header, for why this previously had nowhere to be written) and omitted
 * for `duplicate`, which has nothing to recover.
 */
export async function completeJobReviewOutcome(
  params:
    | {
        jobId: number;
        status: "duplicate";
        httpStatus: number;
        contentType: string;
        contentLength: number;
        sourceItemId: number;
      }
    | {
        jobId: number;
        status: "needs_review";
        httpStatus: number;
        contentType: string;
        contentLength: number;
        sourceItemId?: null;
        reviewMetadata: IngestionReviewMetadataPatch | null;
      }
): Promise<void> {
  const patch = completeWithOutcome({
    status: params.status,
    now: new Date(),
    httpStatus: params.httpStatus,
    contentType: params.contentType,
    contentLength: params.contentLength,
    sourceItemId: params.sourceItemId ?? null,
  });

  const reviewColumns =
    params.status === "needs_review" && params.reviewMetadata
      ? {
          retrievedUrl: params.reviewMetadata.retrievedUrl,
          canonicalUrl: params.reviewMetadata.canonicalUrl,
          rawContentHash: params.reviewMetadata.rawContentHash,
          extractedTitle: params.reviewMetadata.extractedTitle,
          extractedAuthor: params.reviewMetadata.extractedAuthor,
          extractedPublishedAt: params.reviewMetadata.extractedPublishedAt,
          extractedExcerpt: params.reviewMetadata.extractedExcerpt,
          extractedLinksStaging: params.reviewMetadata.extractedLinksStaging,
        }
      : {};

  await adminDb
    .update(ingestionJobs)
    .set({ ...patch, ...reviewColumns })
    .where(eq(ingestionJobs.id, params.jobId));
}

// ---------------------------------------------------------------------------
// Candidate lookups (Section 8/10 reads -- no writes)
// ---------------------------------------------------------------------------

export async function findCandidateSourceItemsByUrl(
  normalizedUrl: string,
  canonicalUrl: string | null
): Promise<CandidateSourceItem[]> {
  const condition = canonicalUrl
    ? or(eq(sourceItems.normalizedUrl, normalizedUrl), eq(sourceItems.canonicalUrl, canonicalUrl))
    : eq(sourceItems.normalizedUrl, normalizedUrl);

  const rows = await adminDb
    .select({
      id: sourceItems.id,
      normalizedUrl: sourceItems.normalizedUrl,
      canonicalUrl: sourceItems.canonicalUrl,
      rawContentHash: sourceItems.rawContentHash,
    })
    .from(sourceItems)
    .where(condition);

  return rows;
}

/** Section 9: surfaced as review/provenance metadata only -- never used to auto-deduplicate. */
export async function findHashCoincidenceSourceItemIds(
  rawContentHash: string,
  excludeIds: number[]
): Promise<number[]> {
  const rows = await adminDb
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(eq(sourceItems.rawContentHash, rawContentHash));

  const excluded = new Set(excludeIds);
  return rows.map((r) => r.id).filter((id) => !excluded.has(id));
}

/** Section 10: the whole `sources` table, for in-memory hostname matching -- small reference table at this project's current scale (see sourceIdentity.ts). */
export async function findAllCandidateSources(): Promise<CandidateSource[]> {
  return adminDb.select({ id: sources.id, homepageUrl: sources.homepageUrl }).from(sources);
}

// ---------------------------------------------------------------------------
// Finalization / confirmation (Section 12, separate explicit step)
// ---------------------------------------------------------------------------

export class JobNotConfirmableError extends Error {
  constructor(jobId: number, reason: string) {
    super(`Ingestion job #${jobId} cannot be confirmed: ${reason}`);
    this.name = "JobNotConfirmableError";
  }
}

/**
 * Persists a `source_items` row for a job the pipeline previously
 * classified as `ready_for_confirmation`, and links the job to it.
 * Nothing is created merely because fetching succeeded -- this is the
 * one and only function in the ingestion pipeline that writes to
 * `source_items`, and it never runs except in direct response to this
 * explicit call (which PR 5's admin UI will invoke from a confirm
 * button; PR 4 wires the function, not the button).
 *
 * `reviewData` -- the pipeline-derived, non-admin-editable facts (the
 * actual retrieved URL, its hash, its canonical URL) that must survive
 * from the original fetch to this confirmation call -- is decoded from
 * `input.reviewToken` below, NOT accepted as separate raw fields (PR 5
 * security condition). The token itself may have been signed either
 * immediately after the original fetch (actions.ts) or re-signed later
 * from this job's own persisted columns (Phase 4 PR 7's
 * `prepareHistoryReviewConfirmation`, below) -- this function does not
 * care which; `verifyReviewPayload` treats both identically, since a
 * re-signed token carries exactly the same guarantee (see that function's
 * comment for why). It is still never accepted as raw editable hidden
 * form fields, since `url` and `rawContentHash` specifically back the
 * whole duplicate-detection integrity guarantee, not just cosmetic
 * metadata. `verifyReviewPayload` also checks the token's embedded
 * `jobId` against `data.jobId`, which is what actually prevents a token
 * from being replayed against a different job.
 *
 * Re-verifies the job is actually still eligible (status = 'needs_review'
 * -- see pipeline.ts's note on why BOTH `ready_for_confirmation` and
 * true `needs_review` pipeline result kinds are stored as the single
 * `needs_review` ingestion_status, since the enum has no separate
 * "awaiting confirmation" value -- and `source_item_id IS NULL`) inside
 * the same transaction via `for("update")`, so two concurrent
 * confirmations of the same job cannot both succeed.
 *
 * Logs TWO audit entries in the same transaction as the writes (Phase 4
 * PR 6): a `source_item` `create` entry -- bringing this path in line
 * with the manual "New Source Item" admin form, which already logged
 * this and this path previously did not -- and an `ingestion_job`
 * `update` entry recording that this specific job reached `stored`.
 */
/**
 * Phase 6 prerequisite: given a normalized/canonical URL value, returns the
 * single `source_items.id` that uniquely matches it (via the SAME dual-field
 * OR policy `findCandidateSourceItemsByUrl` already uses for dedup:
 * normalized_url OR canonical_url), or `null` if zero or MORE THAN ONE
 * distinct source_items row matches. This is the one and only place "is
 * this link resolvable" is decided -- both forward resolution (this job's
 * own newly-staged links) and retroactive resolution (other, pre-existing
 * unresolved links) call this SAME function, so the matching policy can
 * never drift between the two directions. No fuzzy matching of any kind:
 * exact equality only, reusing the existing normalizeUrl() identity, never
 * a second/looser implementation.
 */
async function findUniqueResolutionTarget(
  tx: Parameters<Parameters<typeof adminDb.transaction>[0]>[0],
  normalizedTargetUrl: string
): Promise<number | null> {
  const rows = await tx
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(or(eq(sourceItems.normalizedUrl, normalizedTargetUrl), eq(sourceItems.canonicalUrl, normalizedTargetUrl)));
  const distinctIds = Array.from(new Set(rows.map((r) => r.id)));
  return distinctIds.length === 1 ? distinctIds[0]! : null;
}

export async function finalizeIngestionConfirmation(input: unknown): Promise<{ sourceItemId: number }> {
  const admin = await requireAdmin("editor");
  const data = confirmIngestionSchema.parse(input);
  const reviewData = verifyReviewPayload(data.reviewToken, data.jobId);

  const normalizedResult = normalizeUrl(reviewData.url);
  if (!normalizedResult.ok) {
    // Should be unreachable -- the signed token's `url` was itself
    // produced by a successful normalizeUrl call in pipeline.ts. Kept
    // as a defensive check rather than a silent `!` assertion.
    throw new InvalidSubmissionUrlError("reviewData.url (from the signed review token) is not a valid absolute URL.");
  }
  if (!/^[a-f0-9]{64}$/.test(reviewData.rawContentHash)) {
    throw new Error("reviewData.rawContentHash (from the signed review token) is not a well-formed SHA-256 hex digest.");
  }
  const storedNormalizedUrl = normalizedResult.normalizedUrl;

  return adminDb.transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: ingestionJobs.id,
        status: ingestionJobs.status,
        sourceItemId: ingestionJobs.sourceItemId,
        extractedLinksStaging: ingestionJobs.extractedLinksStaging,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, data.jobId))
      .for("update");

    if (!job) throw new JobNotConfirmableError(data.jobId, "job not found");
    if (job.sourceItemId !== null) throw new JobNotConfirmableError(data.jobId, "already linked to a source item");
    if (job.status !== "needs_review") {
      throw new JobNotConfirmableError(data.jobId, `status is '${job.status}', not the expected reviewable state`);
    }

    const [sourceItem] = await tx
      .insert(sourceItems)
      .values({
        sourceId: data.sourceId,
        itemTypeId: data.itemTypeId,
        url: reviewData.url,
        canonicalUrl: reviewData.canonicalUrl ?? undefined,
        normalizedUrl: storedNormalizedUrl,
        title: data.title,
        author: data.author,
        publishedAt: data.publishedAt,
        excerpt: data.excerpt ?? reviewData.excerpt ?? undefined,
        rawContentHash: reviewData.rawContentHash,
      })
      .returning();

    await tx
      .update(ingestionJobs)
      .set({ status: "stored", sourceItemId: sourceItem!.id, completedAt: new Date() })
      .where(eq(ingestionJobs.id, data.jobId));

    // ---------------------------------------------------------------------
    // Phase 6 prerequisite: promote this job's staged links into durable
    // source_item_links rows, with FORWARD resolution against
    // already-existing source_items rows. Each staged link's target was
    // already fully validated/bounded by linkExtraction.ts before it ever
    // reached the staging column -- nothing here re-filters or re-caps it.
    //
    // A self-link (this new item linking to its own URL) is guarded
    // explicitly: findUniqueResolutionTarget necessarily sees the row we
    // JUST inserted above (same transaction, read-your-own-writes), so a
    // permalink-style self-referential anchor would otherwise resolve to
    // itself -- resolvesToSelf below is what prevents that, matching the
    // source_item_links_no_self_link CHECK constraint's own invariant.
    // ---------------------------------------------------------------------
    const stagedLinks = (job.extractedLinksStaging as unknown as ExtractedLink[] | null) ?? [];
    for (const link of stagedLinks) {
      const resolvedCandidate = await findUniqueResolutionTarget(tx, link.normalizedTargetUrl);
      const resolvesToSelf = resolvedCandidate !== null && resolvedCandidate === sourceItem!.id;
      const toSourceItemId = resolvedCandidate !== null && !resolvesToSelf ? resolvedCandidate : null;
      const resolvedNow = toSourceItemId !== null ? new Date() : null;

      await tx.insert(sourceItemLinks).values({
        fromSourceItemId: sourceItem!.id,
        toSourceItemId,
        targetUrl: link.targetUrl,
        normalizedTargetUrl: link.normalizedTargetUrl,
        anchorText: link.anchorText,
        linkContextSnippet: link.contextSnippet,
        relAttribute: link.relAttribute,
        linkPosition: link.linkPosition,
        placement: link.placement,
        isSameSite: link.isSameSite,
        ingestionJobId: data.jobId,
        resolvedAt: resolvedNow ?? undefined,
      });
    }

    // ---------------------------------------------------------------------
    // Phase 6 prerequisite: RETROACTIVE resolution. Pre-existing,
    // still-unresolved source_item_links rows (created by EARLIER
    // ingestion jobs, never this one -- excluded via ingestion_job_id
    // below) whose target now uniquely matches the item just created are
    // enriched. The just-inserted sourceItem row necessarily matches its
    // own normalized_url, so findUniqueResolutionTarget returning
    // non-null here means it is THE ONLY row matching storedNormalizedUrl
    // -- if any OTHER pre-existing source_items row also shares this URL
    // (the hash-mismatch/edited-content re-ingestion case), the match
    // count is > 1 and this returns null, correctly leaving those older
    // unresolved links unresolved rather than guessing which version of
    // the content they actually meant. Already-resolved rows are never
    // touched (the WHERE clause only ever selects toSourceItemId IS NULL
    // rows), matching the "never re-resolve, never unset" invariant.
    // ---------------------------------------------------------------------
    const retroactiveTarget = await findUniqueResolutionTarget(tx, storedNormalizedUrl);
    if (retroactiveTarget !== null && retroactiveTarget === sourceItem!.id) {
      await tx
        .update(sourceItemLinks)
        .set({ toSourceItemId: sourceItem!.id, resolvedAt: new Date() })
        .where(
          and(
            isNull(sourceItemLinks.toSourceItemId),
            eq(sourceItemLinks.normalizedTargetUrl, storedNormalizedUrl),
            ne(sourceItemLinks.ingestionJobId, data.jobId),
            ne(sourceItemLinks.fromSourceItemId, sourceItem!.id)
          )
        );
    }

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "source_item",
      entityId: sourceItem!.id,
      summary: `Created source item "${sourceItem!.title ?? sourceItem!.url}" via ingestion job #${data.jobId}`,
    });

    await logAdminAction(tx, admin, {
      action: "update",
      entityType: "ingestion_job",
      entityId: data.jobId,
      summary: `Confirmed ingestion job #${data.jobId}, stored as source item #${sourceItem!.id}`,
    });

    return { sourceItemId: sourceItem!.id };
  });
}

// ---------------------------------------------------------------------------
// History-based recovery (Phase 4 PR 7, Section 18: recoverable, not lost)
// ---------------------------------------------------------------------------

export class JobNotReviewableError extends Error {
  constructor(jobId: number, reason: string) {
    super(`Ingestion job #${jobId} cannot be reviewed from history: ${reason}`);
    this.name = "JobNotReviewableError";
  }
}

export interface HistoryReviewPreparation {
  jobId: number;
  reviewToken: string;
  metadata: {
    url: string;
    canonicalUrl: string | null;
    excerpt: string | null;
    rawContentHash: string;
    title: string | null;
    author: string | null;
    publishedAt: Date | null;
  };
  /** Job's original `createdAt` (queue time) -- the UI layer computes any staleness notice from this, not this function (Section 12/18: informational only, never a re-fetch trigger or a confirmation block). */
  createdAt: Date;
}

/**
 * Re-derives a fresh, signed review token for a job that is still
 * `needs_review` and unlinked, from the metadata this same server process
 * persisted at fetch time (migration 0009) -- NOT by re-fetching the URL,
 * and NOT by trusting anything client-supplied. This is what lets
 * `/admin/ingest/history` render the same confirm form `IngestForm.tsx`
 * shows immediately after a `ready_for_confirmation`/`needs_review` result,
 * for a job an admin didn't (or couldn't) act on in that same request.
 *
 * The re-signed token carries exactly the same guarantee as the original:
 * `signReviewPayload` is called here with values read straight from the
 * admin-only, RLS-locked `ingestion_jobs` row -- never from a request body
 * -- so this does not introduce a new trust boundary, only a second, later
 * entry point into the one that already existed. `finalizeIngestionConfirmation`
 * itself is completely unchanged and cannot tell the two apart.
 *
 * Deliberately covers BOTH `ready_for_confirmation` and true `needs_review`
 * pipeline outcomes (ambiguous source match, no source match, hash
 * mismatch) identically -- the DB only ever stores the single
 * `needs_review` status for all of them (see pipeline.ts's note on this),
 * and per product decision an admin manually picks source/item type from
 * History either way; there is no different backend handling for one case
 * versus the other, only what the live confirm form happened to prefill.
 *
 * Throws `JobNotReviewableError` if: the job doesn't exist, is already
 * linked to a source item, is not `needs_review`, or -- the ambiguous-403
 * case (no fetch ever succeeded to extract from), or any job that predates
 * this PR -- has no persisted `retrievedUrl`/`rawContentHash` to build a
 * token from at all. Callers should surface this as an ordinary
 * not-actionable state, not a crash.
 */
export async function prepareHistoryReviewConfirmation(jobId: number): Promise<HistoryReviewPreparation> {
  await requireAdmin("editor");

  const [job] = await adminDb
    .select({
      id: ingestionJobs.id,
      status: ingestionJobs.status,
      sourceItemId: ingestionJobs.sourceItemId,
      createdAt: ingestionJobs.createdAt,
      retrievedUrl: ingestionJobs.retrievedUrl,
      canonicalUrl: ingestionJobs.canonicalUrl,
      rawContentHash: ingestionJobs.rawContentHash,
      extractedTitle: ingestionJobs.extractedTitle,
      extractedAuthor: ingestionJobs.extractedAuthor,
      extractedPublishedAt: ingestionJobs.extractedPublishedAt,
      extractedExcerpt: ingestionJobs.extractedExcerpt,
    })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.id, jobId))
    .limit(1);

  if (!job) throw new JobNotReviewableError(jobId, "job not found");
  if (job.sourceItemId !== null) throw new JobNotReviewableError(jobId, "already linked to a source item");
  if (job.status !== "needs_review") {
    throw new JobNotReviewableError(jobId, `status is '${job.status}', not the expected reviewable state`);
  }
  if (!job.retrievedUrl || !job.rawContentHash) {
    throw new JobNotReviewableError(
      jobId,
      "no persisted review metadata for this job -- either the fetch that produced it never returned content to extract from (e.g. the ambiguous-403 case), or it predates Phase 4 PR 7"
    );
  }

  const reviewToken = signReviewPayload({
    jobId: job.id,
    url: job.retrievedUrl,
    canonicalUrl: job.canonicalUrl,
    excerpt: job.extractedExcerpt,
    rawContentHash: job.rawContentHash,
  });

  return {
    jobId: job.id,
    reviewToken,
    metadata: {
      url: job.retrievedUrl,
      canonicalUrl: job.canonicalUrl,
      excerpt: job.extractedExcerpt,
      rawContentHash: job.rawContentHash,
      title: job.extractedTitle,
      author: job.extractedAuthor,
      publishedAt: job.extractedPublishedAt,
    },
    createdAt: job.createdAt,
  };
}
