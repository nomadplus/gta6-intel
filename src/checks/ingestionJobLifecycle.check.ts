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
  const patch = completeWithFailure({ status: "fetch_failed", now: NOW, failureReason: "The request timed out." });
  assert(patch.status === "fetch_failed", "completeWithFailure sets the given failure status");
  assert(patch.failureReason === "The request timed out.", "completeWithFailure carries the failure reason through");
  assert(patch.nextRetryAt === null, "no Retry-After info -> nextRetryAt stays null");
}

{
  const patch = completeWithFailure({ status: "rate_limited", now: NOW, failureReason: "429", retryAfterDelayMs: 30_000 });
  assert(
    patch.nextRetryAt !== null && patch.nextRetryAt.getTime() === NOW.getTime() + 30_000,
    "a Retry-After delay is converted into an absolute nextRetryAt, relative to 'now'"
  );
}

if (failures > 0) {
  console.error(`\n${failures} job lifecycle check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll job lifecycle checks passed.");
}
