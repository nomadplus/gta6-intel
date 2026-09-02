/**
 * Regression check for src/lib/ai/duplicateCheckActionability.ts,
 * specifically computeDuplicateCheckDisplayState's precedence rule.
 *
 * Added after PR-A visual QA surfaced a real pre-existing defect: a
 * candidate's real, already-completed detect_duplicates job (e.g.
 * status "failed") was being silently masked whenever hasExistingClaims
 * (computed against DUPLICATE_CHECK_DEFAULT_PROJECT_ID) evaluated false
 * for the environment's actual project id -- see the corrected function's
 * own header comment for the full explanation. This check proves the job
 * is now consulted first, and that the composed workflow-state module
 * (candidateWorkflowState.ts) still lets a reviewed outcome take final
 * precedence over even a correctly-computed duplicate-check state.
 *
 * No database, no network -- same shape as
 * src/checks/classificationRecoveryLifecycle.check.ts and
 * src/checks/candidateWorkflowState.check.ts.
 *
 * Run with: npx tsx src/checks/duplicateCheckActionability.check.ts
 */
import {
  computeDuplicateCheckDisplayState,
  type DuplicateCheckDisplayState,
} from "../lib/ai/duplicateCheckActionability";
import type { DetectDuplicatesJobForDisplay } from "../lib/ai/detectDuplicatesRecoveryLifecycle";
import { computeCandidateWorkflowState } from "../lib/ai/candidateWorkflowState";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== duplicate-check display state precedence (job truth over hasExistingClaims) ===\n");

const now = new Date("2026-09-01T12:00:00Z");

function job(status: DetectDuplicatesJobForDisplay["status"]): DetectDuplicatesJobForDisplay {
  return { status, createdAt: new Date("2026-09-01T11:00:00Z"), startedAt: new Date("2026-09-01T11:00:01Z") };
}

// --- The exact QA-discovered scenario: a real failed job must not be ------
// masked by hasExistingClaims=false (e.g. because the environment's real
// claims live under a different project id than the hardcoded default).

assert(
  computeDuplicateCheckDisplayState(false, job("failed"), now) === "failed",
  "hasExistingClaims=false + a real failed job -> 'failed' (the job is consulted, not masked)"
);

assert(
  computeDuplicateCheckDisplayState(false, job("succeeded"), now) === "succeeded",
  "hasExistingClaims=false + a real succeeded job -> 'succeeded' (job truth wins even here too)"
);

// --- hasExistingClaims only matters when there is genuinely no job at all -

assert(
  computeDuplicateCheckDisplayState(true, null, now) === "not_checked",
  "hasExistingClaims=true + no job -> 'not_checked' (the genuinely-never-checked case, preserved)"
);

assert(
  computeDuplicateCheckDisplayState(false, null, now) === "no_existing_claims",
  "hasExistingClaims=false + no job -> 'no_existing_claims' (unchanged -- this is the only case hasExistingClaims was ever meant to govern)"
);

// --- Composed with the workflow-state module: a reviewed outcome still ----
// wins over even a correctly-computed duplicate-check state (this is what
// actually reaches the six-state chip the admin sees).

const failedDuplicateState: DuplicateCheckDisplayState = computeDuplicateCheckDisplayState(false, job("failed"), now);
assert(failedDuplicateState === "failed", "sanity: failedDuplicateState fixture really is 'failed' before composing");

assert(
  computeCandidateWorkflowState({ action: "approve" }, failedDuplicateState) === "approved",
  "a correctly-computed 'failed' duplicate state + an 'approve' review still presents as 'approved'"
);
assert(
  computeCandidateWorkflowState({ action: "link_existing_claim" }, failedDuplicateState) === "linked",
  "a correctly-computed 'failed' duplicate state + a 'link_existing_claim' review still presents as 'linked'"
);
assert(
  computeCandidateWorkflowState({ action: "reject" }, failedDuplicateState) === "rejected",
  "a correctly-computed 'failed' duplicate state + a 'reject' review still presents as 'rejected'"
);
assert(
  computeCandidateWorkflowState(null, failedDuplicateState) === "failed",
  "the same 'failed' duplicate state with no review at all presents as 'failed' (the QA-reported bug, now fixed end to end)"
);

console.log(
  failures === 0 ? "\nAll duplicate-check display state precedence checks passed." : `\n${failures} check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
