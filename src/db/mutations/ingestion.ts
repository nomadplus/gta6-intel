import "server-only";
import { and, eq, inArray, or } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { ingestionJobs, discoveryProviders, sourceItems, sources } from "@/db/schema";
import { requireAdmin, type AuthorizedAdmin } from "@/lib/auth/requireAdmin";
import { submitIngestionUrlSchema, confirmIngestionSchema } from "@/lib/validation/adminSchemas";
import { normalizeUrl } from "@/lib/ingestion/urlNormalization";
import { verifyReviewPayload } from "@/lib/ingestion/reviewPayloadSigning";
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

/**
 * NOTE on admin_audit_log: ingestion job creation and lifecycle
 * transitions are deliberately NOT logged there in this PR.
 * `admin_audit_entity_type` has no `ingestion_job` value (a genuine
 * schema gap, flagged during PR 4 planning), and per explicit decision
 * this PR does not add one -- ingestion is left unaudited there for
 * now. `ingestion_jobs.admin_user_id`/`created_at`/`completed_at`
 * remain the (thinner, mutable-in-place) record of who/when. Revisit
 * if/when a future PR wants full audit-log coverage for ingestion.
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
  adminId: number;
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
      return { reused: true, job: job! };
    }

    const [job] = await tx
      .insert(ingestionJobs)
      .values({
        submittedUrl: params.submittedUrl,
        normalizedUrl: params.normalizedUrl,
        discoveryProviderId: manualProviderId,
        initiatedBy: "human",
        adminUserId: params.adminId,
        status: "queued",
      })
      .returning();

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

/** A definitive non-success outcome (Section 4/13). */
export async function completeJobFailure(
  jobId: number,
  outcome: IngestionFailureOutcome,
  retryAfterDelayMs?: number | null
): Promise<void> {
  const patch = completeWithFailure({
    status: outcome.status,
    now: new Date(),
    failureReason: outcome.failureReason,
    retryAfterDelayMs,
  });
  await adminDb.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, jobId));
}

/** A successful fetch that resolved to `duplicate` or `needs_review` (Section 8) -- no source_items row is created for either. */
export async function completeJobReviewOutcome(params: {
  jobId: number;
  status: "duplicate" | "needs_review";
  httpStatus: number;
  contentType: string;
  contentLength: number;
  sourceItemId?: number | null;
}): Promise<void> {
  const patch = completeWithOutcome({
    status: params.status,
    now: new Date(),
    httpStatus: params.httpStatus,
    contentType: params.contentType,
    contentLength: params.contentLength,
    sourceItemId: params.sourceItemId,
  });
  await adminDb.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, params.jobId));
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
 * security condition). `ingestion_jobs` still has no columns to persist
 * it server-side between fetch and confirm (see PR 4 planning notes),
 * so it still round-trips through the browser -- but as an opaque,
 * HMAC-signed token (reviewPayloadSigning.ts) rather than editable
 * hidden form fields, since `url` and `rawContentHash` specifically
 * back the whole duplicate-detection integrity guarantee, not just
 * cosmetic metadata. `verifyReviewPayload` also checks the token's
 * embedded `jobId` against `data.jobId`, which is what actually
 * prevents a token from being replayed against a different job.
 *
 * Re-verifies the job is actually still eligible (status = 'needs_review'
 * -- see pipeline.ts's note on why BOTH `ready_for_confirmation` and
 * true `needs_review` pipeline result kinds are stored as the single
 * `needs_review` ingestion_status, since the enum has no separate
 * "awaiting confirmation" value -- and `source_item_id IS NULL`) inside
 * the same transaction via `for("update")`, so two concurrent
 * confirmations of the same job cannot both succeed.
 */
export async function finalizeIngestionConfirmation(input: unknown): Promise<{ sourceItemId: number }> {
  await requireAdmin("editor");
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
      .select({ id: ingestionJobs.id, status: ingestionJobs.status, sourceItemId: ingestionJobs.sourceItemId })
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

    return { sourceItemId: sourceItem!.id };
  });
}
