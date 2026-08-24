/**
 * Regression check for Phase 5 PR 4's generalized, operation-neutral
 * pure recovery logic (src/lib/ai/aiJobRecoveryLifecycle.ts) -- the
 * shared module extracted out of classificationRecoveryLifecycle.ts so
 * extract_claims can reuse the same staleness/display-status logic
 * without duplicating it. No database, no network.
 *
 * Deliberately tests THIS module directly (not through either operation's
 * thin wrapper) to prove the shared logic itself is correct and
 * genuinely operation-agnostic -- in particular, that its "no job at all"
 * state is named 'missing', not any operation-flavored word like
 * 'unclassified' or 'unextracted' (those relabelings are each wrapper's
 * own job -- see classificationRecoveryLifecycle.check.ts and
 * extractClaimsOrchestration.check.ts for proof that the wrappers relabel
 * correctly).
 *
 * Run with: npx tsx src/checks/aiJobRecoveryLifecycle.check.ts
 */
import { isStaleInFlightAiJob, computeAiJobDisplayStatus, aiJobAgeMs } from "../lib/ai/aiJobRecoveryLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== shared ai_jobs recovery lifecycle (Phase 5 PR 4) ===\n");

const NOW = new Date("2026-01-01T00:00:00Z");
const THRESHOLD_MS = 5 * 60 * 1000;

// --- aiJobAgeMs / isStaleInFlightAiJob: 'running' anchors on startedAt -----

{
  const recentlyStarted = {
    status: "running" as const,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    startedAt: new Date(NOW.getTime() - 1000),
  };
  assert(
    !isStaleInFlightAiJob(recentlyStarted, NOW, THRESHOLD_MS),
    "a 'running' job that only just started is NOT stale, even if it sat 'pending' for a long time beforehand (anchors on startedAt, not createdAt)"
  );
  assert(aiJobAgeMs(recentlyStarted, NOW) === 1000, "aiJobAgeMs for a running job measures from startedAt");
}

{
  const longRunning = {
    status: "running" as const,
    createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000),
    startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000),
  };
  assert(isStaleInFlightAiJob(longRunning, NOW, THRESHOLD_MS), "a 'running' job whose startedAt is past the threshold IS stale");
}

// --- 'pending' anchors on createdAt -----------------------------------------

{
  const recentlyQueued = { status: "pending" as const, createdAt: new Date(NOW.getTime() - 1000), startedAt: null };
  assert(!isStaleInFlightAiJob(recentlyQueued, NOW, THRESHOLD_MS), "a recently-queued 'pending' job is NOT stale");
  assert(aiJobAgeMs(recentlyQueued, NOW) === 1000, "aiJobAgeMs for a pending job measures from createdAt");
}

{
  const longQueued = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null };
  assert(isStaleInFlightAiJob(longQueued, NOW, THRESHOLD_MS), "a 'pending' job past the threshold (by createdAt) IS stale");
}

// --- exact threshold boundary ------------------------------------------------

{
  const exactlyAtThreshold = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS), startedAt: null };
  assert(
    !isStaleInFlightAiJob(exactlyAtThreshold, NOW, THRESHOLD_MS),
    "a job exactly AT the threshold is not yet stale -- staleness is strictly greater-than, not greater-or-equal"
  );
}

// --- computeAiJobDisplayStatus: 'missing' (not any operation-specific word) -

{
  assert(computeAiJobDisplayStatus(null, NOW, THRESHOLD_MS) === "missing", "no job at all maps to the operation-neutral 'missing', not 'unclassified'/'unextracted'/any other domain word");
}

{
  const status = computeAiJobDisplayStatus(
    { status: "succeeded", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 900) },
    NOW,
    THRESHOLD_MS
  );
  assert(status === "succeeded", "a succeeded job maps to 'succeeded' regardless of age");
}

{
  const status = computeAiJobDisplayStatus(
    { status: "failed", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 900) },
    NOW,
    THRESHOLD_MS
  );
  assert(status === "failed", "a failed job maps to 'failed' regardless of age");
}

{
  const status = computeAiJobDisplayStatus({ status: "pending", createdAt: new Date(NOW.getTime() - 1000), startedAt: null }, NOW, THRESHOLD_MS);
  assert(status === "in_progress", "a FRESH pending job maps to 'in_progress', NEVER collapsed into 'missing' or 'failed'");
}

{
  const status = computeAiJobDisplayStatus(
    { status: "running", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 500) },
    NOW,
    THRESHOLD_MS
  );
  assert(status === "in_progress", "a FRESH running job maps to 'in_progress', NEVER collapsed into 'missing' or 'failed'");
}

{
  const status = computeAiJobDisplayStatus(
    { status: "pending", createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null },
    NOW,
    THRESHOLD_MS
  );
  assert(status === "stale", "a STALE pending job maps to 'stale', distinct from both 'in_progress' and 'failed'");
}

{
  const status = computeAiJobDisplayStatus(
    { status: "running", createdAt: new Date(NOW.getTime() - 60 * 60 * 1000), startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000) },
    NOW,
    THRESHOLD_MS
  );
  assert(status === "stale", "a STALE running job (by startedAt) maps to 'stale'");
}

console.log(failures === 0 ? "\nAll shared ai_jobs recovery lifecycle checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
