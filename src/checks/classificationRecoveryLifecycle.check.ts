/**
 * Regression check for Phase 5 PR 3's pure classification-recovery logic
 * (src/lib/ai/classificationRecoveryLifecycle.ts): staleness detection
 * and the five-way admin display-status mapping. No database, no
 * network -- same shape as src/checks/aiJobLifecycle.check.ts.
 *
 * Run with: npx tsx src/checks/classificationRecoveryLifecycle.check.ts
 */
import {
  isStaleInFlightClassificationJob,
  computeClassificationDisplayStatus,
  CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS,
} from "../lib/ai/classificationRecoveryLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== classification recovery lifecycle (Phase 5 PR 3) ===\n");

const NOW = new Date("2026-01-01T00:00:00Z");

// --- isStaleInFlightClassificationJob: 'running' anchors on startedAt ------

{
  const recentlyStarted = {
    status: "running" as const,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000), // queued an hour ago
    startedAt: new Date(NOW.getTime() - 1000), // but only started 1s ago
  };
  assert(
    !isStaleInFlightClassificationJob(recentlyStarted, NOW),
    "a 'running' job that only just started is NOT stale, even if it sat 'pending' for a long time beforehand (anchors on startedAt, not createdAt)"
  );
}

{
  const longRunning = {
    status: "running" as const,
    createdAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS - 1000),
    startedAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS - 1000),
  };
  assert(
    isStaleInFlightClassificationJob(longRunning, NOW),
    "a 'running' job whose startedAt is past the threshold IS stale"
  );
}

// --- isStaleInFlightClassificationJob: 'pending' anchors on createdAt ------

{
  const recentlyQueued = {
    status: "pending" as const,
    createdAt: new Date(NOW.getTime() - 1000),
    startedAt: null,
  };
  assert(!isStaleInFlightClassificationJob(recentlyQueued, NOW), "a recently-queued 'pending' job is NOT stale");
}

{
  const longQueued = {
    status: "pending" as const,
    createdAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS - 1000),
    startedAt: null,
  };
  assert(isStaleInFlightClassificationJob(longQueued, NOW), "a 'pending' job past the threshold (by createdAt) IS stale");
}

// --- exact threshold boundary -----------------------------------------------

{
  const exactlyAtThreshold = {
    status: "pending" as const,
    createdAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS),
    startedAt: null,
  };
  assert(
    !isStaleInFlightClassificationJob(exactlyAtThreshold, NOW),
    "a job exactly AT the threshold is not yet stale -- staleness is strictly greater-than, not greater-or-equal"
  );
}

// --- computeClassificationDisplayStatus -------------------------------------

{
  assert(computeClassificationDisplayStatus(null, NOW) === "unclassified", "no job at all maps to 'unclassified'");
}

{
  const status = computeClassificationDisplayStatus(
    { status: "succeeded", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 900) },
    NOW
  );
  assert(status === "succeeded", "a succeeded job maps to 'succeeded' regardless of age");
}

{
  const status = computeClassificationDisplayStatus(
    { status: "failed", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 900) },
    NOW
  );
  assert(status === "failed", "a failed job maps to 'failed' regardless of age");
}

{
  const status = computeClassificationDisplayStatus(
    { status: "pending", createdAt: new Date(NOW.getTime() - 1000), startedAt: null },
    NOW
  );
  assert(
    status === "in_progress",
    "a FRESH pending job maps to 'in_progress', NEVER collapsed into 'unclassified' or 'failed'"
  );
}

{
  const status = computeClassificationDisplayStatus(
    { status: "running", createdAt: new Date(NOW.getTime() - 1000), startedAt: new Date(NOW.getTime() - 500) },
    NOW
  );
  assert(
    status === "in_progress",
    "a FRESH running job maps to 'in_progress', NEVER collapsed into 'unclassified' or 'failed'"
  );
}

{
  const status = computeClassificationDisplayStatus(
    {
      status: "pending",
      createdAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS - 1000),
      startedAt: null,
    },
    NOW
  );
  assert(status === "stale", "a STALE pending job maps to 'stale', distinct from both 'in_progress' and 'failed'");
}

{
  const status = computeClassificationDisplayStatus(
    {
      status: "running",
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      startedAt: new Date(NOW.getTime() - CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS - 1000),
    },
    NOW
  );
  assert(status === "stale", "a STALE running job (by startedAt) maps to 'stale'");
}

console.log(failures === 0 ? "\nAll classification recovery lifecycle checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
