/**
 * Regression check for src/lib/ingestion/ingestionJobLifecycle.ts.
 *
 * Run with: npx tsx src/checks/ingestionJobLifecycle.check.ts
 */
import {
  findReusableInflightJob,
  beginFetchAttempt,
  completeWithOutcome,
  completeWithFailure,
  INFLIGHT_REDUNDANCY_WINDOW_MS,
  MAX_INGESTION_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  MAX_RETRY_AFTER_DELAY_MS,
  RECOVERY_STALE_THRESHOLD_MS,
  isRetryableFailureStatus,
  computeRetryDelayMs,
  reclaimStaleFetchingJob,
  type InflightJobCandidate,
} from "../lib/ingestion/ingestionJobLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const NOW = new Date("2026-06-15T12:00:00Z");

// --- Same normalized URL queued within 1 hour -> returns existing job -----
{
  const candidates: InflightJobCandidate[] = [
    { id: 1, status: "queued", createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) }, // 10 min ago
  ];
  const reused = findReusableInflightJob(candidates, NOW);
  assert(reused?.id === 1, "a 'queued' job created 10 minutes ago is reused");
}

// --- Same normalized URL fetching within 1 hour -> returns existing job ----
{
  const candidates: InflightJobCandidate[] = [
    { id: 2, status: "fetching", createdAt: new Date(NOW.getTime() - 45 * 60 * 1000) }, // 45 min ago
  ];
  const reused = findReusableInflightJob(candidates, NOW);
  assert(reused?.id === 2, "a 'fetching' job created 45 minutes ago is reused");
}

// --- Same normalized URL older than 1 hour -> not reused (new job needed) --
{
  const candidates: InflightJobCandidate[] = [
    { id: 3, status: "queued", createdAt: new Date(NOW.getTime() - 61 * 60 * 1000) }, // 61 min ago
  ];
  const reused = findReusableInflightJob(candidates, NOW);
  assert(reused === null, "a job created 61 minutes ago (outside the 1-hour window) is NOT reused");
}

// --- Exactly at the window boundary is excluded (strict inequality) --------
{
  const candidates: InflightJobCandidate[] = [
    { id: 4, status: "queued", createdAt: new Date(NOW.getTime() - INFLIGHT_REDUNDANCY_WINDOW_MS) },
  ];
  const reused = findReusableInflightJob(candidates, NOW);
  assert(reused === null, "a job created exactly 1 hour ago is outside the window (strict cutoff, not inclusive)");
}

// --- No candidates at all -> null, new job created --------------------------
{
  const reused = findReusableInflightJob([], NOW);
  assert(reused === null, "no candidates -> null (a new job should be created)");
}

// --- Most recent candidate wins when multiple are eligible -------------------
{
  const candidates: InflightJobCandidate[] = [
    { id: 5, status: "queued", createdAt: new Date(NOW.getTime() - 50 * 60 * 1000) },
    { id: 6, status: "fetching", createdAt: new Date(NOW.getTime() - 5 * 60 * 1000) },
  ];
  const reused = findReusableInflightJob(candidates, NOW);
  assert(reused?.id === 6, "when multiple in-window candidates exist, the most recently created one is reused");
}

// --- Historical (terminal-status) rows never reach this function -----------
// (Section 2: "Do not use historical source_items.normalizedUrl to skip
// a fetch" -- and by construction, this function's caller only ever
// queries ingestion_jobs WHERE status IN ('queued','fetching'), so a
// 'stored'/'duplicate'/etc row is never among the candidates passed in.
// Documented here rather than tested directly, since InflightJobCandidate's
// own type only allows 'queued'|'fetching' -- the type system itself
// enforces this contract at the call site.)

// --- Lifecycle: startedAt only set when fetch begins ------------------------
{
  const patch = beginFetchAttempt(0, NOW);
  assert(patch.status === "fetching", "beginFetchAttempt sets status to 'fetching'");
  assert(patch.startedAt.getTime() === NOW.getTime(), "beginFetchAttempt sets startedAt to the provided 'now', not queue time");
}

// --- attemptCount increments correctly --------------------------------------
{
  assert(beginFetchAttempt(0, NOW).attemptCount === 1, "attemptCount 0 -> 1 on first fetch attempt");
  assert(beginFetchAttempt(1, NOW).attemptCount === 2, "attemptCount 1 -> 2 on a second attempt (e.g. after a retry)");
  assert(beginFetchAttempt(4, NOW).attemptCount === 5, "attemptCount increments by exactly 1 regardless of starting value");
}

// --- Success/failure terminal states -----------------------------------
{
  const patch = completeWithOutcome({ status: "duplicate", now: NOW, httpStatus: 200, contentType: "text/html", contentLength: 1234, sourceItemId: 42 });
  assert(patch.status === "duplicate", "completeWithOutcome sets the given terminal status");
  assert(patch.sourceItemId === 42, "completeWithOutcome carries the linked sourceItemId through for 'duplicate'");
  assert(patch.failureReason === null, "a success-shaped outcome has a null failureReason");
  assert(patch.completedAt.getTime() === NOW.getTime(), "completeWithOutcome sets completedAt");
}

{
  const patch = completeWithOutcome({ status: "needs_review", now: NOW, httpStatus: 200, contentType: "text/html", contentLength: 500 });
  assert(patch.sourceItemId === null, "completeWithOutcome defaults sourceItemId to null when not provided (needs_review case)");
}

{
  const patch = completeWithFailure({ status: "fetch_failed", now: NOW, failureReason: "The request timed out.", attemptCount: 1 });
  assert(patch.status === "fetch_failed", "completeWithFailure sets the given failure status");
  assert(patch.failureReason === "The request timed out.", "completeWithFailure carries the failure reason through");
}

{
  const patch = completeWithFailure({ status: "rate_limited", now: NOW, failureReason: "429", attemptCount: 1, retryAfterDelayMs: 30_000 });
  assert(
    patch.nextRetryAt !== null && patch.nextRetryAt.getTime() === NOW.getTime() + 30_000,
    "a Retry-After delay is converted into an absolute nextRetryAt, relative to 'now'"
  );
}

// ---------------------------------------------------------------------------
// Phase 4 PR 9: automated retry policy
// ---------------------------------------------------------------------------

// --- Retryable vs. non-retryable status classification ---------------------
{
  assert(isRetryableFailureStatus("fetch_failed"), "fetch_failed is retryable");
  assert(isRetryableFailureStatus("rate_limited"), "rate_limited is retryable");
  assert(!isRetryableFailureStatus("blocked_by_policy"), "blocked_by_policy is NOT retryable");
  assert(!isRetryableFailureStatus("authentication_required"), "authentication_required is NOT retryable");
  assert(!isRetryableFailureStatus("paywalled"), "paywalled is NOT retryable");
  assert(!isRetryableFailureStatus("unsupported"), "unsupported is NOT retryable");
  assert(!isRetryableFailureStatus("malformed"), "malformed is NOT retryable");
  assert(!isRetryableFailureStatus("needs_review"), "needs_review is NOT retryable");
}

// --- A non-retryable status never gets nextRetryAt, even with attempts left -
{
  const patch = completeWithFailure({
    status: "blocked_by_policy",
    now: NOW,
    failureReason: "blocked hostname",
    attemptCount: 1,
  });
  assert(patch.nextRetryAt === null, "a non-retryable status with no Retry-After stays permanently terminal (nextRetryAt null)");
}

// --- A retryable status with no Retry-After header computes backoff --------
{
  const zeroJitter = () => 0;
  const patch = completeWithFailure({
    status: "fetch_failed",
    now: NOW,
    failureReason: "timeout",
    attemptCount: 1,
    random: zeroJitter,
  });
  assert(patch.nextRetryAt !== null, "a retryable status with no Retry-After still schedules a computed retry");
  assert(
    patch.nextRetryAt!.getTime() === NOW.getTime() + RETRY_BASE_DELAY_MS,
    "first computed retry (attemptCount=1, zero jitter) uses exactly RETRY_BASE_DELAY_MS"
  );
}

// --- Backoff doubles on each subsequent attempt -----------------------------
{
  const zeroJitter = () => 0;
  assert(computeRetryDelayMs(1, zeroJitter) === RETRY_BASE_DELAY_MS, "attempt 1 -> base delay");
  assert(computeRetryDelayMs(2, zeroJitter) === RETRY_BASE_DELAY_MS * 2, "attempt 2 -> 2x base delay");
  assert(computeRetryDelayMs(3, zeroJitter) === RETRY_BASE_DELAY_MS * 4, "attempt 3 -> 4x base delay");
}

// --- Jitter adds up to (but never more than) RETRY_JITTER_RATIO -------------
{
  const maxJitter = () => 0.999999;
  const delay = computeRetryDelayMs(1, maxJitter);
  assert(delay > RETRY_BASE_DELAY_MS, "jitter pushes the delay above the bare base delay");
  assert(delay < RETRY_BASE_DELAY_MS * 1.31, "jitter never exceeds roughly base * (1 + 0.3)");
}

// --- Exhaustion: at MAX_INGESTION_ATTEMPTS, no further retry is scheduled ---
{
  const patch = completeWithFailure({
    status: "fetch_failed",
    now: NOW,
    failureReason: "timeout",
    attemptCount: MAX_INGESTION_ATTEMPTS,
  });
  assert(
    patch.nextRetryAt === null,
    `a job at MAX_INGESTION_ATTEMPTS (${MAX_INGESTION_ATTEMPTS}) is left permanently terminal, not retried again`
  );
}
{
  // Even an honored Retry-After must not override exhaustion.
  const patch = completeWithFailure({
    status: "rate_limited",
    now: NOW,
    failureReason: "429",
    attemptCount: MAX_INGESTION_ATTEMPTS,
    retryAfterDelayMs: 5_000,
  });
  assert(patch.nextRetryAt === null, "exhaustion applies even when a valid Retry-After is present");
}

// --- Retry-After is capped, never honored past MAX_RETRY_AFTER_DELAY_MS ----
{
  const absurdlyLongDelayMs = 1000 * 60 * 60 * 24 * 365; // 1 year
  const patch = completeWithFailure({
    status: "rate_limited",
    now: NOW,
    failureReason: "429",
    attemptCount: 1,
    retryAfterDelayMs: absurdlyLongDelayMs,
  });
  assert(
    patch.nextRetryAt!.getTime() === NOW.getTime() + MAX_RETRY_AFTER_DELAY_MS,
    "an excessive upstream Retry-After is capped at MAX_RETRY_AFTER_DELAY_MS, not honored verbatim"
  );
}
{
  const modestDelayMs = 10_000; // well under the cap
  const patch = completeWithFailure({
    status: "rate_limited",
    now: NOW,
    failureReason: "429",
    attemptCount: 1,
    retryAfterDelayMs: modestDelayMs,
  });
  assert(
    patch.nextRetryAt!.getTime() === NOW.getTime() + modestDelayMs,
    "a Retry-After well under the cap is honored exactly, uncapped"
  );
}

// --- Stale 'fetching' reclaim ------------------------------------------------
{
  const zeroJitter = () => 0;
  const patch = reclaimStaleFetchingJob(1, NOW, zeroJitter);
  assert(patch.status === "fetch_failed", "a reclaimed stale-fetching job is recorded as fetch_failed");
  assert(patch.failureReason.includes("Reclaimed"), "the failure reason is distinguishable from a real fetch error");
  assert(
    patch.nextRetryAt!.getTime() === NOW.getTime() + RETRY_BASE_DELAY_MS,
    "a reclaimed job with attempts remaining gets a normal computed backoff"
  );
}
{
  const patch = reclaimStaleFetchingJob(MAX_INGESTION_ATTEMPTS, NOW);
  assert(
    patch.nextRetryAt === null,
    "a reclaimed job that has already exhausted its attempts is left permanently terminal, not retried again"
  );
}

// --- Sanity: the stale threshold is comfortably beyond a single fetch's budget
{
  assert(
    RECOVERY_STALE_THRESHOLD_MS > 45_000,
    "RECOVERY_STALE_THRESHOLD_MS leaves headroom above safeFetch's 45s total timeout budget"
  );
}

if (failures > 0) {
  console.error(`\n${failures} job lifecycle check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll job lifecycle checks passed.");
}
