/**
 * Regression check for Phase 5 PR 7's compare_claims recovery lifecycle
 * (src/lib/ai/compareClaimsRecoveryLifecycle.ts) and the six-state
 * relationship-analysis actionability mapping
 * (src/lib/ai/relationshipAnalysisActionability.ts). Pure -- no
 * database, no network.
 *
 * Covers:
 *   - staleness anchors on startedAt for 'running', createdAt for 'pending'
 *   - exact-threshold boundary is NOT yet stale (strictly greater-than)
 *   - the shared 'missing' state relabels to this operation's own
 *     'not_analysed' vocabulary
 *   - all six RelationshipAnalysisDisplayState values compute correctly,
 *     including no_comparable_claims (computed independently of job
 *     history, unlike the other five)
 *   - exactly 3 of 6 states are actionable
 *   - LOCKED DECISION: 'succeeded' has NO action -- PR7 provides no
 *     re-analysis control from a succeeded state
 *
 * Run with: npx tsx src/checks/compareClaimsRecoveryLifecycle.check.ts
 */
import {
  isStaleInFlightCompareClaimsJob,
  compareClaimsJobAgeMs,
  computeCompareClaimsJobDisplayStatus,
  COMPARE_CLAIMS_RECOVERY_STALE_THRESHOLD_MS,
} from "../lib/ai/compareClaimsRecoveryLifecycle";
import {
  computeRelationshipAnalysisDisplayState,
  canTriggerRelationshipAnalysis,
  relationshipAnalysisAction,
  relationshipAnalysisButtonLabel,
  type RelationshipAnalysisDisplayState,
} from "../lib/ai/relationshipAnalysisActionability";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== compare_claims recovery lifecycle + actionability (Phase 5 PR 7) -- pure, no DB ===\n");

const NOW = new Date("2026-01-01T00:00:00Z");
const THRESHOLD_MS = COMPARE_CLAIMS_RECOVERY_STALE_THRESHOLD_MS;

// --- staleness anchoring -------------------------------------------------------
{
  const recentlyStarted = { status: "running" as const, createdAt: new Date(NOW.getTime() - 60 * 60 * 1000), startedAt: new Date(NOW.getTime() - 1000) };
  assert(!isStaleInFlightCompareClaimsJob(recentlyStarted, NOW), "a 'running' job that just started is NOT stale even after sitting 'pending' a long time (anchors on startedAt)");
  assert(compareClaimsJobAgeMs(recentlyStarted, NOW) === 1000, "compareClaimsJobAgeMs for a running job measures from startedAt");

  const longRunning = { status: "running" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000) };
  assert(isStaleInFlightCompareClaimsJob(longRunning, NOW), "a 'running' job whose startedAt is past the threshold IS stale");

  const recentlyQueued = { status: "pending" as const, createdAt: new Date(NOW.getTime() - 1000), startedAt: null };
  assert(!isStaleInFlightCompareClaimsJob(recentlyQueued, NOW), "a recently-queued 'pending' job is NOT stale");

  const longQueued = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null };
  assert(isStaleInFlightCompareClaimsJob(longQueued, NOW), "a 'pending' job past the threshold (by createdAt) IS stale");

  const exactlyAtThreshold = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS), startedAt: null };
  assert(!isStaleInFlightCompareClaimsJob(exactlyAtThreshold, NOW), "a job exactly AT the threshold is not yet stale -- strictly greater-than, not greater-or-equal");
}

// --- job-status vocabulary relabeling ------------------------------------------
{
  assert(computeCompareClaimsJobDisplayStatus(null, NOW) === "not_analysed", "no job at all maps to this operation's own 'not_analysed', not the shared module's generic 'missing'");
  assert(
    computeCompareClaimsJobDisplayStatus({ status: "succeeded", createdAt: NOW, startedAt: NOW }, NOW) === "succeeded",
    "a succeeded job maps to 'succeeded'"
  );
  assert(computeCompareClaimsJobDisplayStatus({ status: "failed", createdAt: NOW, startedAt: NOW }, NOW) === "failed", "a failed job maps to 'failed'");
  assert(
    computeCompareClaimsJobDisplayStatus({ status: "pending", createdAt: NOW, startedAt: null }, NOW) === "in_progress",
    "a fresh pending job maps to 'in_progress'"
  );
  assert(
    computeCompareClaimsJobDisplayStatus({ status: "pending", createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null }, NOW) === "stale",
    "a stale pending job maps to 'stale'"
  );
}

// --- six-state RelationshipAnalysisDisplayState --------------------------------
{
  assert(
    computeRelationshipAnalysisDisplayState(false, null, NOW) === "no_comparable_claims",
    "hasComparableClaims=false -> no_comparable_claims, REGARDLESS of job history"
  );
  assert(
    computeRelationshipAnalysisDisplayState(false, { status: "succeeded", createdAt: NOW, startedAt: NOW }, NOW) === "no_comparable_claims",
    "hasComparableClaims=false wins even when a succeeded job exists (e.g. every other claim became related since)"
  );
  assert(computeRelationshipAnalysisDisplayState(true, null, NOW) === "not_analysed", "hasComparableClaims=true, no job -> not_analysed");
  assert(
    computeRelationshipAnalysisDisplayState(true, { status: "pending", createdAt: NOW, startedAt: null }, NOW) === "in_progress",
    "hasComparableClaims=true, fresh pending job -> in_progress"
  );
  assert(
    computeRelationshipAnalysisDisplayState(true, { status: "pending", createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null }, NOW) ===
      "stale",
    "hasComparableClaims=true, stale pending job -> stale"
  );
  assert(
    computeRelationshipAnalysisDisplayState(true, { status: "failed", createdAt: NOW, startedAt: NOW }, NOW) === "failed",
    "hasComparableClaims=true, failed job -> failed"
  );
  assert(
    computeRelationshipAnalysisDisplayState(true, { status: "succeeded", createdAt: NOW, startedAt: NOW }, NOW) === "succeeded",
    "hasComparableClaims=true, succeeded job -> succeeded"
  );
}

// --- exactly 3 of 6 states are actionable --------------------------------------
{
  const allStates: RelationshipAnalysisDisplayState[] = ["no_comparable_claims", "not_analysed", "in_progress", "stale", "failed", "succeeded"];
  const actionableStates = allStates.filter(canTriggerRelationshipAnalysis);
  assert(actionableStates.length === 3, `exactly 3 of 6 states are actionable (got ${actionableStates.length}: ${actionableStates.join(", ")})`);
  assert(
    new Set(actionableStates).size === 3 &&
      actionableStates.includes("not_analysed") &&
      actionableStates.includes("stale") &&
      actionableStates.includes("failed"),
    "the three actionable states are exactly not_analysed/stale/failed"
  );

  assert(canTriggerRelationshipAnalysis("no_comparable_claims") === false, "no_comparable_claims is NOT actionable");
  assert(canTriggerRelationshipAnalysis("in_progress") === false, "in_progress is NOT actionable");
  assert(canTriggerRelationshipAnalysis("succeeded") === false, "LOCKED DECISION: succeeded is NOT actionable -- PR7 provides no re-analysis control from a succeeded state");

  assert(relationshipAnalysisAction("not_analysed") === "analyse", "not_analysed's action is 'analyse'");
  assert(relationshipAnalysisAction("stale") === "recover", "stale's action is 'recover'");
  assert(relationshipAnalysisAction("failed") === "retry", "failed's action is 'retry'");
  assert(relationshipAnalysisAction("no_comparable_claims") === null, "no_comparable_claims has no action");
  assert(relationshipAnalysisAction("in_progress") === null, "in_progress has no action");
  assert(relationshipAnalysisAction("succeeded") === null, "succeeded has no action");

  assert(relationshipAnalysisButtonLabel("not_analysed") === "Analyse relationships", "not_analysed's button label is 'Analyse relationships'");
  assert(relationshipAnalysisButtonLabel("stale") === "Recover", "stale's button label is 'Recover'");
  assert(relationshipAnalysisButtonLabel("failed") === "Retry", "failed's button label is 'Retry'");
  assert(relationshipAnalysisButtonLabel("no_comparable_claims") === null, "no_comparable_claims has no button label");
  assert(relationshipAnalysisButtonLabel("in_progress") === null, "in_progress has no button label");
  assert(relationshipAnalysisButtonLabel("succeeded") === null, "succeeded has no button label");
}

console.log(failures === 0 ? "\nAll compare_claims recovery lifecycle + actionability checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
