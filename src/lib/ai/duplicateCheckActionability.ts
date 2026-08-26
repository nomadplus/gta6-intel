/**
 * Phase 5 PR 6. Pure mapping from PR6's six-state duplicate-check display
 * model to whether the admin review page should show an action control,
 * and which one. Deliberately its own module, not inlined into
 * src/app/admin/(protected)/review/page.tsx, so this decision logic is
 * checkable in isolation -- same reasoning as extractionActionability.ts.
 *
 * Six states, not five: this operation adds "no_existing_claims" on top
 * of the shared job-status five (not_checked / in_progress / stale /
 * failed / succeeded) -- see detectDuplicatesRecoveryLifecycle.ts's
 * header for why that sixth state is computed independently of job
 * history, not folded into the shared module.
 *
 * Locked UI rule (Phase 5 PR 6): exactly 3 of the 6 states are
 * actionable -- not_checked ("Check duplicates"), stale ("Recover"), and
 * failed ("Retry"). no_existing_claims, in_progress, and succeeded all
 * render with NO action control -- no_existing_claims because running a
 * check would be pointless (and would cost nothing anyway, since
 * detectDuplicatesTrigger.ts never creates a job in that case); succeeded
 * because this PR deliberately does not offer a re-check action, same
 * restraint as extractionActionability.ts's succeeded state.
 *
 * A reviewed candidate (approved, rejected, or resolved to an existing
 * claim) is NOT one of these six states -- it is a separate, higher-
 * priority condition the review page checks first (mirroring PR5's own
 * existing `candidate.review ? <Outcome/> : <duplicate-check UI/>`
 * branch): once a candidate is reviewed, this entire module is bypassed
 * and only the review outcome renders, regardless of what state these
 * functions would otherwise compute. The actual enforcement of "no new
 * check/retry/recovery after review" lives at the server layer
 * (detectDuplicatesTrigger.ts / detectDuplicatesRecovery.ts), not here --
 * this module only controls what button renders.
 */
import type { DetectDuplicatesJobDisplayStatus, DetectDuplicatesJobForDisplay } from "./detectDuplicatesRecoveryLifecycle";
import { computeDetectDuplicatesJobDisplayStatus } from "./detectDuplicatesRecoveryLifecycle";

export type DuplicateCheckDisplayState = "no_existing_claims" | DetectDuplicatesJobDisplayStatus;

/**
 * hasExistingClaims should be recomputed fresh on every render from the
 * deterministic retrieval fact (countAllClaims(...) > 0) -- never cached,
 * never derived from a stale job row. Claims are never hard-deleted
 * anywhere in this codebase, so this is monotonic: once true, always
 * true, and a candidate naturally and correctly flips from
 * no_existing_claims to not_checked the moment the project's first claim
 * exists, with no special-case transition logic needed here.
 */
export function computeDuplicateCheckDisplayState(
  hasExistingClaims: boolean,
  job: DetectDuplicatesJobForDisplay | null,
  now: Date,
  thresholdMs?: number
): DuplicateCheckDisplayState {
  if (!hasExistingClaims) return "no_existing_claims";
  return computeDetectDuplicatesJobDisplayStatus(job, now, thresholdMs);
}

export type DuplicateCheckAction = "check" | "recover" | "retry";

/** True for exactly 3 of the 6 DuplicateCheckDisplayState values -- see header. */
export function canTriggerDuplicateCheck(state: DuplicateCheckDisplayState): boolean {
  return state === "not_checked" || state === "stale" || state === "failed";
}

/** null for the three non-actionable states (no_existing_claims, in_progress, succeeded). */
export function duplicateCheckAction(state: DuplicateCheckDisplayState): DuplicateCheckAction | null {
  if (state === "not_checked") return "check";
  if (state === "stale") return "recover";
  if (state === "failed") return "retry";
  return null;
}

const ACTION_LABEL: Record<DuplicateCheckAction, string> = {
  check: "Check duplicates",
  recover: "Recover",
  retry: "Retry",
};

/** null for the three non-actionable states -- callers must not render a button in that case. */
export function duplicateCheckButtonLabel(state: DuplicateCheckDisplayState): string | null {
  const action = duplicateCheckAction(state);
  return action ? ACTION_LABEL[action] : null;
}
