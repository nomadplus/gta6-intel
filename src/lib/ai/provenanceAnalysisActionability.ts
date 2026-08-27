/**
 * Phase 5 PR 8b. Pure mapping from PR8b's six-state provenance-analysis
 * display model to whether the admin claim page should show an action
 * control, and which one. Deliberately its own module, not inlined into
 * src/app/admin/(protected)/claims/[id]/page.tsx, same reasoning as
 * relationshipAnalysisActionability.ts (PR7) and duplicateCheckActionability.ts.
 *
 * Six states, not five: this operation adds "no_analysable_cluster" on top
 * of the shared job-status five (not_analysed / in_progress / stale /
 * failed / succeeded) -- see provenanceAnalysisRecoveryLifecycle.ts's
 * header for why that sixth state is computed independently of job
 * history, not folded into the shared module.
 *
 * FOUR actions, not three: unlike PR7's compare_claims (which provides no
 * re-analysis control from "succeeded" at all), PR8b's re-analysis is
 * CLUSTER-CHANGE-GATED -- "succeeded" exposes a "reanalyse" action only
 * when the claim's CURRENT linked source-item cluster fingerprint differs
 * from the fingerprint the latest succeeded job actually analysed. This
 * keeps the required six DISPLAY states exactly as specified while still
 * satisfying "Support analyse/recover/retry/reanalyse" -- reanalyse is an
 * ACTION available from the "succeeded" state under one specific
 * condition, not a seventh display state.
 *
 * hasAnalysableCluster/currentClusterFingerprint should both be
 * recomputed fresh on every render from the deterministic cluster-size /
 * cluster-contents facts -- never cached, never derived from a stale job
 * row. Like PR7's hasComparableClaims, this is NOT strictly monotonic: a
 * claim's cluster can shrink back to size <= 1 if sources are unlinked.
 */
import type {
  ProvenanceAnalysisJobDisplayStatus,
  ProvenanceAnalysisJobForDisplay,
} from "./provenanceAnalysisRecoveryLifecycle";
import { computeProvenanceAnalysisJobDisplayStatus } from "./provenanceAnalysisRecoveryLifecycle";

export type ProvenanceAnalysisDisplayState = "no_analysable_cluster" | ProvenanceAnalysisJobDisplayStatus;

export function computeProvenanceAnalysisDisplayState(
  hasAnalysableCluster: boolean,
  job: ProvenanceAnalysisJobForDisplay | null,
  now: Date,
  thresholdMs?: number
): ProvenanceAnalysisDisplayState {
  if (!hasAnalysableCluster) return "no_analysable_cluster";
  return computeProvenanceAnalysisJobDisplayStatus(job, now, thresholdMs);
}

export type ProvenanceAnalysisAction = "analyse" | "recover" | "retry" | "reanalyse";

/**
 * True for not_analysed/stale/failed always, and for succeeded ONLY when
 * the current cluster fingerprint no longer matches the fingerprint the
 * latest succeeded job actually analysed. `latestSucceededFingerprint`
 * and `currentClusterFingerprint` are both required whenever `state` is
 * "succeeded" -- callers pass null for either when state isn't
 * "succeeded" (they are simply ignored in that branch).
 */
export function canTriggerProvenanceAnalysis(
  state: ProvenanceAnalysisDisplayState,
  latestSucceededFingerprint: string | null,
  currentClusterFingerprint: string | null
): boolean {
  if (state === "not_analysed" || state === "stale" || state === "failed") return true;
  if (state === "succeeded") {
    return latestSucceededFingerprint !== null && currentClusterFingerprint !== null && latestSucceededFingerprint !== currentClusterFingerprint;
  }
  return false;
}

export function provenanceAnalysisAction(
  state: ProvenanceAnalysisDisplayState,
  latestSucceededFingerprint: string | null,
  currentClusterFingerprint: string | null
): ProvenanceAnalysisAction | null {
  if (state === "not_analysed") return "analyse";
  if (state === "stale") return "recover";
  if (state === "failed") return "retry";
  if (state === "succeeded" && canTriggerProvenanceAnalysis(state, latestSucceededFingerprint, currentClusterFingerprint)) {
    return "reanalyse";
  }
  return null;
}

const ACTION_LABEL: Record<ProvenanceAnalysisAction, string> = {
  analyse: "Analyse provenance",
  recover: "Recover",
  retry: "Retry",
  reanalyse: "Re-analyse (cluster changed)",
};

export function provenanceAnalysisButtonLabel(
  state: ProvenanceAnalysisDisplayState,
  latestSucceededFingerprint: string | null,
  currentClusterFingerprint: string | null
): string | null {
  const action = provenanceAnalysisAction(state, latestSucceededFingerprint, currentClusterFingerprint);
  return action ? ACTION_LABEL[action] : null;
}
