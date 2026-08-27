/**
 * Regression check for Phase 5 PR 8b's analyse_provenance recovery
 * lifecycle (src/lib/ai/provenanceAnalysisRecoveryLifecycle.ts) and the
 * six-state provenance-analysis actionability mapping with its
 * fingerprint-gated FOURTH action
 * (src/lib/ai/provenanceAnalysisActionability.ts). Pure -- no database,
 * no network.
 *
 * Covers:
 *   - staleness anchors on startedAt for 'running', createdAt for 'pending'
 *   - exact-threshold boundary is NOT yet stale (strictly greater-than)
 *   - the shared 'missing' state relabels to this operation's own
 *     'not_analysed' vocabulary
 *   - all six ProvenanceAnalysisDisplayState values compute correctly,
 *     including no_analysable_cluster (computed independently of job
 *     history, unlike the other five)
 *   - not_analysed/stale/failed are ALWAYS actionable, regardless of
 *     fingerprint arguments
 *   - PR8b DIVERGENCE FROM PR7: 'succeeded' IS actionable (action
 *     'reanalyse'), but ONLY when the current cluster fingerprint
 *     differs from the latest succeeded job's own fingerprint -- when
 *     they match, 'succeeded' has NO action, matching PR7's own restraint
 *     in that one case
 */
import {
  isStaleInFlightProvenanceAnalysisJob,
  provenanceAnalysisJobAgeMs,
  computeProvenanceAnalysisJobDisplayStatus,
  PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS,
} from "../lib/ai/provenanceAnalysisRecoveryLifecycle";
import {
  computeProvenanceAnalysisDisplayState,
  canTriggerProvenanceAnalysis,
  provenanceAnalysisAction,
  provenanceAnalysisButtonLabel,
  type ProvenanceAnalysisDisplayState,
} from "../lib/ai/provenanceAnalysisActionability";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== analyse_provenance recovery lifecycle + actionability (Phase 5 PR 8b) -- pure, no DB ===\n");

const NOW = new Date("2026-01-01T00:00:00Z");
const THRESHOLD_MS = PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS;

// --- staleness anchoring -------------------------------------------------------
{
  const recentlyStarted = { status: "running" as const, createdAt: new Date(NOW.getTime() - 60 * 60 * 1000), startedAt: new Date(NOW.getTime() - 1000) };
  assert(!isStaleInFlightProvenanceAnalysisJob(recentlyStarted, NOW), "a 'running' job that just started is NOT stale even after sitting 'pending' a long time (anchors on startedAt)");
  assert(provenanceAnalysisJobAgeMs(recentlyStarted, NOW) === 1000, "provenanceAnalysisJobAgeMs for a running job measures from startedAt");

  const longRunning = { status: "running" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000) };
  assert(isStaleInFlightProvenanceAnalysisJob(longRunning, NOW), "a 'running' job whose startedAt is past the threshold IS stale");

  const pending = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null };
  assert(isStaleInFlightProvenanceAnalysisJob(pending, NOW), "a 'pending' job past the threshold (measured from createdAt) IS stale");

  const exactBoundary = { status: "pending" as const, createdAt: new Date(NOW.getTime() - THRESHOLD_MS), startedAt: null };
  assert(!isStaleInFlightProvenanceAnalysisJob(exactBoundary, NOW), "a job EXACTLY at the threshold is NOT yet stale (strictly greater-than)");
}

// --- 'missing' relabels to 'not_analysed' --------------------------------------
{
  assert(computeProvenanceAnalysisJobDisplayStatus(null, NOW) === "not_analysed", "no job at all maps to 'not_analysed', not the shared 'missing' label");
}

// --- all six display states ----------------------------------------------------
{
  assert(computeProvenanceAnalysisDisplayState(false, null, NOW) === "no_analysable_cluster", "cluster size <= 1 maps to 'no_analysable_cluster' regardless of job history");
  assert(
    computeProvenanceAnalysisDisplayState(true, null, NOW) === "not_analysed",
    "cluster size > 1 with no job maps to 'not_analysed'"
  );
  assert(
    computeProvenanceAnalysisDisplayState(true, { status: "pending", createdAt: NOW, startedAt: null }, NOW) === "in_progress",
    "cluster size > 1 with a fresh pending job maps to 'in_progress'"
  );
  assert(
    computeProvenanceAnalysisDisplayState(true, { status: "pending", createdAt: new Date(NOW.getTime() - THRESHOLD_MS - 1000), startedAt: null }, NOW) === "stale",
    "cluster size > 1 with a stale in-flight job maps to 'stale'"
  );
  assert(
    computeProvenanceAnalysisDisplayState(true, { status: "failed", createdAt: NOW, startedAt: NOW }, NOW) === "failed",
    "cluster size > 1 with a failed job maps to 'failed'"
  );
  assert(
    computeProvenanceAnalysisDisplayState(true, { status: "succeeded", createdAt: NOW, startedAt: NOW }, NOW) === "succeeded",
    "cluster size > 1 with a succeeded job maps to 'succeeded'"
  );
}

// --- not_analysed/stale/failed are ALWAYS actionable, ignoring fingerprints ----
{
  const alwaysActionable: ProvenanceAnalysisDisplayState[] = ["not_analysed", "stale", "failed"];
  for (const state of alwaysActionable) {
    assert(canTriggerProvenanceAnalysis(state, null, null), `'${state}' is actionable with null/null fingerprints`);
    assert(canTriggerProvenanceAnalysis(state, "fp-a", "fp-a"), `'${state}' is actionable even when fingerprints happen to match`);
    assert(canTriggerProvenanceAnalysis(state, "fp-a", "fp-b"), `'${state}' is actionable when fingerprints differ`);
  }
  assert(provenanceAnalysisAction("not_analysed", null, null) === "analyse", "'not_analysed' action is 'analyse'");
  assert(provenanceAnalysisAction("stale", null, null) === "recover", "'stale' action is 'recover'");
  assert(provenanceAnalysisAction("failed", null, null) === "retry", "'failed' action is 'retry'");
}

// --- no_analysable_cluster / in_progress are NEVER actionable ------------------
{
  assert(!canTriggerProvenanceAnalysis("no_analysable_cluster", null, null), "'no_analysable_cluster' is never actionable");
  assert(!canTriggerProvenanceAnalysis("in_progress", null, null), "'in_progress' is never actionable");
  assert(provenanceAnalysisAction("no_analysable_cluster", null, null) === null, "'no_analysable_cluster' action is null");
  assert(provenanceAnalysisButtonLabel("in_progress", null, null) === null, "'in_progress' button label is null");
}

// --- PR8b's own divergence from PR7: 'succeeded' + fingerprint gating ----------
{
  assert(
    !canTriggerProvenanceAnalysis("succeeded", "same-fp", "same-fp"),
    "'succeeded' with an UNCHANGED cluster fingerprint has NO action -- matches PR7's restraint in this one case"
  );
  assert(provenanceAnalysisAction("succeeded", "same-fp", "same-fp") === null, "'succeeded' unchanged-fingerprint action is null");
  assert(provenanceAnalysisButtonLabel("succeeded", "same-fp", "same-fp") === null, "'succeeded' unchanged-fingerprint button label is null");

  assert(
    canTriggerProvenanceAnalysis("succeeded", "old-fp", "new-fp"),
    "'succeeded' with a CHANGED cluster fingerprint IS actionable -- PR8b's cluster-change-gated reanalyse, unlike PR7's compare_claims"
  );
  assert(provenanceAnalysisAction("succeeded", "old-fp", "new-fp") === "reanalyse", "'succeeded' changed-fingerprint action is 'reanalyse'");
  assert(provenanceAnalysisButtonLabel("succeeded", "old-fp", "new-fp") !== null, "'succeeded' changed-fingerprint button label is non-null");

  // Missing fingerprint data (null on either side) must never be treated
  // as "changed" -- absence of information is not evidence of change.
  assert(!canTriggerProvenanceAnalysis("succeeded", null, "new-fp"), "'succeeded' with a null latestSucceededFingerprint is NOT treated as actionable");
  assert(!canTriggerProvenanceAnalysis("succeeded", "old-fp", null), "'succeeded' with a null currentClusterFingerprint is NOT treated as actionable");
}

console.log(failures === 0 ? "\nAll analyse_provenance recovery lifecycle + actionability checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
