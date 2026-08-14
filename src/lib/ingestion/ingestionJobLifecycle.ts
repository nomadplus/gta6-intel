/**
 * Pure decision logic for `ingestion_jobs` state, kept separate from
 * the actual database reads/writes in `src/db/mutations/ingestion.ts`
 * so both the redundancy window and the lifecycle transitions can be
 * exercised deterministically with plain in-memory objects and an
 * injected clock -- no live Postgres needed for these checks (Section
 * 18: "No deterministic test should depend on the public internet",
 * extended here to not depending on a database either, for the parts
 * that don't need one).
 */

/** Section 2: the fixed redundancy window. Not schema-enforced (see migration 0007's index comment) -- purely application logic, which is why it lives here as an explicit, overridable constant rather than a magic number. */
export const INFLIGHT_REDUNDANCY_WINDOW_MS = 60 * 60 * 1000;

export interface InflightJobCandidate {
  id: number;
  status: "queued" | "fetching";
  createdAt: Date;
}

/**
 * Given the `ingestion_jobs` rows the caller already fetched for a
 * given `normalizedUrl` (status IN ('queued','fetching'), a query the
 * `ingestion_jobs_inflight_lookup_idx` partial index makes cheap),
 * decides whether one of them should be reused instead of creating a
 * new job.
 *
 * This is a STALE-REQUEST/NETWORK-HAMMERING GUARD ONLY (Section 2) --
 * it never considers `stored`/`duplicate`/other terminal-status rows,
 * and it is not historical deduplication (that's a separate, later
 * stage -- see duplicateDetection.ts).
 *
 * Returns the most recently created eligible job, or `null` if none
 * qualifies (either no candidates at all, or all of them fall outside
 * the redundancy window).
 */
export function findReusableInflightJob(
  candidates: readonly InflightJobCandidate[],
  now: Date,
  windowMs: number = INFLIGHT_REDUNDANCY_WINDOW_MS
): InflightJobCandidate | null {
  const cutoff = now.getTime() - windowMs;
  const eligible = candidates
    .filter((job) => job.createdAt.getTime() > cutoff)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return eligible[0] ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle transition patches
//
// Each function returns a plain object describing exactly which columns
// change for that transition -- the caller (ingestion.ts) applies it in
// an UPDATE. Keeping these as pure, individually-testable functions is
// what makes "startedAt only set when fetch begins" and "attemptCount
// increments correctly" (Section 18) checkable without a database.
// ---------------------------------------------------------------------------

export interface FetchStartPatch {
  status: "fetching";
  startedAt: Date;
  attemptCount: number;
}

/** Section 3: startedAt is set here, when the fetch actually begins -- never at job creation (createdAt covers queue time). */
export function beginFetchAttempt(previousAttemptCount: number, now: Date): FetchStartPatch {
  return { status: "fetching", startedAt: now, attemptCount: previousAttemptCount + 1 };
}

export interface TerminalSuccessPatch {
  status: "stored" | "duplicate" | "needs_review";
  completedAt: Date;
  httpStatus: number;
  contentType: string;
  contentLength: number;
  sourceItemId: number | null;
  failureReason: null;
}

/**
 * Builds the patch for a fetch that completed (2xx response actually
 * retrieved) and was classified into one of the three non-failure
 * outcomes. `sourceItemId` is non-null only for `duplicate` (linked to
 * the existing item, Section 8) -- `stored` isn't reachable from this
 * PR (that only happens after PR 5's confirmation step actually
 * inserts a `source_items` row and finalizes the job; see
 * finalizeIngestionConfirmation in ingestion.ts), and `needs_review`
 * has no source item to link yet.
 */
export function completeWithOutcome(params: {
  status: "stored" | "duplicate" | "needs_review";
  now: Date;
  httpStatus: number;
  contentType: string;
  contentLength: number;
  sourceItemId?: number | null;
}): TerminalSuccessPatch {
  return {
    status: params.status,
    completedAt: params.now,
    httpStatus: params.httpStatus,
    contentType: params.contentType,
    contentLength: params.contentLength,
    sourceItemId: params.sourceItemId ?? null,
    failureReason: null,
  };
}

export interface TerminalFailurePatch {
  status:
    | "blocked_by_policy"
    | "authentication_required"
    | "paywalled"
    | "unsupported"
    | "fetch_failed"
    | "rate_limited"
    | "malformed"
    | "needs_review";
  completedAt: Date;
  failureReason: string;
  nextRetryAt: Date | null;
}

/** Builds the patch for a fetch that failed (or landed in the ambiguous 403 -> needs_review case), per statusMapping.ts's classification. */
export function completeWithFailure(params: {
  status: TerminalFailurePatch["status"];
  now: Date;
  failureReason: string;
  retryAfterDelayMs?: number | null;
}): TerminalFailurePatch {
  return {
    status: params.status,
    completedAt: params.now,
    failureReason: params.failureReason,
    nextRetryAt:
      params.retryAfterDelayMs != null ? new Date(params.now.getTime() + params.retryAfterDelayMs) : null,
  };
}
