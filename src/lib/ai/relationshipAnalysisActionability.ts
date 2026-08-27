/**
 * Phase 5 PR 7. Pure mapping from PR7's six-state relationship-analysis
 * display model to whether the admin claim page should show an action
 * control, and which one. Deliberately its own module, not inlined into
 * src/app/admin/(protected)/claims/[id]/page.tsx, so this decision logic
 * is checkable in isolation -- same reasoning as
 * duplicateCheckActionability.ts.
 *
 * Six states, not five: this operation adds "no_comparable_claims" on top
 * of the shared job-status five (not_analysed / in_progress / stale /
 * failed / succeeded) -- see compareClaimsRecoveryLifecycle.ts's header
 * for why that sixth state is computed independently of job history, not
 * folded into the shared module.
 *
 * Locked UI rule (Phase 5 PR 7, mirroring PR6 exactly): exactly 3 of the 6
 * states are actionable -- not_analysed ("Analyse relationships"), stale
 * ("Recover"), and failed ("Retry"). no_comparable_claims, in_progress,
 * and succeeded all render with NO action control -- no_comparable_claims
 * because running an analysis would be pointless (and would cost nothing
 * anyway, since compareClaimsTrigger.ts never creates a job in that
 * case); succeeded because PR7 deliberately provides no re-analysis
 * control from that state (locked decision -- re-analysis semantics are
 * deferred to a later, graph-change-aware PR once Autonomous Web
 * Discovery increases claim volume).
 *
 * A reviewed assessment (approved, approved-with-changes, or rejected) is
 * NOT one of these six states -- each assessment within a succeeded
 * result is its own independently reviewable row, mirroring PR5's/PR6's
 * own existing per-candidate review branch. The actual enforcement of "no
 * re-analysis from succeeded" lives at the server layer
 * (compareClaimsTrigger.ts has no re-analysis entry point at all in this
 * PR), not here -- this module only controls what button renders on the
 * relationship-analysis SECTION itself, not on individual assessment
 * rows.
 */
import type { CompareClaimsJobDisplayStatus, CompareClaimsJobForDisplay } from "./compareClaimsRecoveryLifecycle";
import { computeCompareClaimsJobDisplayStatus } from "./compareClaimsRecoveryLifecycle";

export type RelationshipAnalysisDisplayState = "no_comparable_claims" | CompareClaimsJobDisplayStatus;

/**
 * hasComparableClaims should be recomputed fresh on every render from the
 * deterministic shortlist-eligibility fact (countComparableClaims(...) >
 * 0) -- never cached, never derived from a stale job row. Unlike PR6's
 * hasExistingClaims (which is monotonic, since claims are never
 * hard-deleted), this fact is NOT strictly monotonic: a claim can move
 * from "has comparable claims" back to "has none" if every other claim in
 * its project becomes already-related to it (the exclusion rule locked
 * for PR7). That is a normal, expected outcome of doing the analysis
 * repeatedly and approving/rejecting its results, not an edge case to
 * special-case here.
 */
export function computeRelationshipAnalysisDisplayState(
  hasComparableClaims: boolean,
  job: CompareClaimsJobForDisplay | null,
  now: Date,
  thresholdMs?: number
): RelationshipAnalysisDisplayState {
  if (!hasComparableClaims) return "no_comparable_claims";
  return computeCompareClaimsJobDisplayStatus(job, now, thresholdMs);
}

export type RelationshipAnalysisAction = "analyse" | "recover" | "retry";

/** True for exactly 3 of the 6 RelationshipAnalysisDisplayState values -- see header. */
export function canTriggerRelationshipAnalysis(state: RelationshipAnalysisDisplayState): boolean {
  return state === "not_analysed" || state === "stale" || state === "failed";
}

/** null for the three non-actionable states (no_comparable_claims, in_progress, succeeded). */
export function relationshipAnalysisAction(state: RelationshipAnalysisDisplayState): RelationshipAnalysisAction | null {
  if (state === "not_analysed") return "analyse";
  if (state === "stale") return "recover";
  if (state === "failed") return "retry";
  return null;
}

const ACTION_LABEL: Record<RelationshipAnalysisAction, string> = {
  analyse: "Analyse relationships",
  recover: "Recover",
  retry: "Retry",
};

/** null for the three non-actionable states -- callers must not render a button in that case. */
export function relationshipAnalysisButtonLabel(state: RelationshipAnalysisDisplayState): string | null {
  const action = relationshipAnalysisAction(state);
  return action ? ACTION_LABEL[action] : null;
}
