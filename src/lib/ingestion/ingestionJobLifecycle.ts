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

// ---------------------------------------------------------------------------
// Phase 4 PR 9 -- automated retry policy
//
// Everything below is pure decision logic (no I/O), same rationale as the
// rest of this file: the claiming/scheduling behavior it drives has to be
// exercisable with plain objects and an injected clock/random source, not
// only against a live Postgres instance.
// ---------------------------------------------------------------------------

/**
 * Total attempts allowed per job (the original attempt plus retries).
 * Once `attemptCount` reaches this, a job is left permanently in its
 * terminal failure status -- Section 4 (historical integrity): nothing
 * is deleted or silently hidden, it simply stops being retried.
 */
export const MAX_INGESTION_ATTEMPTS = 3;

/** Base delay for the first computed retry, before backoff multiplies it. */
export const RETRY_BASE_DELAY_MS = 60_000; // 1 minute

/** Each subsequent retry's base delay doubles. */
export const RETRY_BACKOFF_MULTIPLIER = 2;

/** Random jitter added on top of the exponential base, as a ratio (0 to this value) -- spreads out retries that would otherwise all land on the same instant. */
export const RETRY_JITTER_RATIO = 0.3;

/**
 * Upper bound on an *honored* upstream Retry-After value before it's
 * persisted as `nextRetryAt`. `parseRetryAfter` (safeFetch.ts) itself
 * does not cap the header it parses -- this was fine while nothing ever
 * acted on the value, but PR 9 is the first thing that actually
 * schedules work from it, so an unbounded or malicious Retry-After
 * (e.g. a far-future date) must not be able to functionally suspend a
 * job's retries indefinitely without it ever reaching a clean terminal
 * state.
 */
export const MAX_RETRY_AFTER_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The subset of failure statuses PR 9's automated processor will ever
 * retry. Deliberately narrow and explicit rather than "everything that
 * isn't needs_review" -- each status here is a transient, network- or
 * server-shaped failure where a later attempt might succeed;
 * blocked_by_policy/authentication_required/paywalled/unsupported/
 * malformed are all durable properties of the target or our own policy
 * that a retry cannot fix. `fetch_failed` also covers `too_many_redirects`
 * (see statusMapping.ts) -- accepted as retryable rather than introducing
 * a new status/schema change to separate that edge case out.
 */
export const RETRYABLE_FAILURE_STATUSES: ReadonlySet<TerminalFailurePatch["status"]> = new Set([
  "fetch_failed",
  "rate_limited",
]);

export function isRetryableFailureStatus(status: TerminalFailurePatch["status"]): boolean {
  return RETRYABLE_FAILURE_STATUSES.has(status);
}

/**
 * Computes a retry delay in milliseconds for the given attempt count,
 * using exponential backoff with jitter. `attemptCount` is the number of
 * attempts already made (1-indexed, matching `ingestion_jobs.attempt_count`
 * immediately after a fetch attempt begins) -- so a job whose first
 * attempt just failed (attemptCount = 1) gets the base delay; its second
 * failure (attemptCount = 2) gets double that; and so on.
 *
 * `random` is injectable (defaulting to `Math.random`) so tests can
 * assert exact delay values rather than a range.
 */
export function computeRetryDelayMs(attemptCount: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attemptCount - 1);
  const base = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_MULTIPLIER ** exponent;
  const jitterRatio = random() * RETRY_JITTER_RATIO;
  return Math.round(base * (1 + jitterRatio));
}

/** Builds the patch for a fetch that failed (or landed in the ambiguous 403 -> needs_review case), per statusMapping.ts's classification. */
export function completeWithFailure(params: {
  status: TerminalFailurePatch["status"];
  now: Date;
  failureReason: string;
  /**
   * The job's attempt count as of this failure (i.e. including the
   * attempt that just failed) -- required so retry eligibility and
   * backoff can both be computed from the same number the eventual
   * claiming query filters on (`attempt_count < MAX_INGESTION_ATTEMPTS`).
   */
  attemptCount: number;
  /** A valid, already-parsed upstream Retry-After delay, if the response carried one. Not yet capped -- this function applies MAX_RETRY_AFTER_DELAY_MS itself. */
  retryAfterDelayMs?: number | null;
  /** Injectable for deterministic backoff tests; defaults to Math.random. */
  random?: () => number;
}): TerminalFailurePatch {
  const exhausted = params.attemptCount >= MAX_INGESTION_ATTEMPTS;

  let nextRetryAt: Date | null = null;
  if (!exhausted) {
    if (params.retryAfterDelayMs != null) {
      // An explicit upstream signal always takes precedence over our own
      // computed backoff -- capped, per this file's header, so a
      // malformed/adversarial value can't suspend retries indefinitely.
      const cappedDelayMs = Math.min(params.retryAfterDelayMs, MAX_RETRY_AFTER_DELAY_MS);
      nextRetryAt = new Date(params.now.getTime() + cappedDelayMs);
    } else if (isRetryableFailureStatus(params.status)) {
      const computedDelayMs = computeRetryDelayMs(params.attemptCount, params.random);
      nextRetryAt = new Date(params.now.getTime() + computedDelayMs);
    }
    // Non-retryable status with no Retry-After: nextRetryAt stays null,
    // same as before this PR -- a durable failure, not a scheduling gap.
  }

  return {
    status: params.status,
    completedAt: params.now,
    failureReason: params.failureReason,
    nextRetryAt,
  };
}

// ---------------------------------------------------------------------------
// Stale 'fetching' recovery (Phase 4 PR 9)
// ---------------------------------------------------------------------------

/**
 * How long a job may sit in 'fetching' before it's considered abandoned
 * (the process that started it died or was killed) and eligible to be
 * reclaimed. A single safeFetch call is capped at 45s total
 * (DEFAULT_TOTAL_TIMEOUT_MS) -- this is deliberately several times that,
 * to leave headroom for clock skew and DB round-trip time without
 * reclaiming a job that is still being legitimately processed. The same
 * threshold is reused for a stuck 'queued' job (created but never
 * picked up), since both represent "a request died before this job
 * reached its next state," not two different failure modes.
 */
export const RECOVERY_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const STALE_FETCHING_RECLAIM_REASON =
  "Reclaimed: job remained in 'fetching' past the stale threshold, likely an interrupted process.";

/**
 * Builds the patch for a job found stuck in 'fetching' past
 * RECOVERY_STALE_THRESHOLD_MS. Delegates to completeWithFailure with a
 * fixed status/reason -- this is not a new kind of outcome, it's the
 * same "fetch_failed, maybe-retryable" shape as any other transient
 * failure, just discovered by staleness rather than by an actual error
 * response. `attemptCount` should be the job's current (already
 * incremented, from when the stale attempt began) value -- this
 * function does not increment it again.
 */
export function reclaimStaleFetchingJob(
  attemptCount: number,
  now: Date,
  random: () => number = Math.random
): TerminalFailurePatch {
  return completeWithFailure({
    status: "fetch_failed",
    now,
    failureReason: STALE_FETCHING_RECLAIM_REASON,
    attemptCount,
    retryAfterDelayMs: null,
    random,
  });
}
