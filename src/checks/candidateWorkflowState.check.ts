/**
 * Regression check for the Admin Review workspace's (PR-A) pure
 * presentation-state logic (src/lib/ai/candidateWorkflowState.ts):
 * six-state workflow mapping, unresolved-first ordering, and deterministic
 * default-selection. No database, no network -- same shape as
 * src/checks/classificationRecoveryLifecycle.check.ts.
 *
 * Run with: npx tsx src/checks/candidateWorkflowState.check.ts
 */
import {
  computeCandidateWorkflowState,
  isResolvedWorkflowState,
  orderWorkspaceCandidatesUnresolvedFirst,
  selectWorkspaceCandidate,
  type CandidateWorkflowState,
} from "../lib/ai/candidateWorkflowState";
import type { DuplicateCheckDisplayState } from "../lib/ai/duplicateCheckActionability";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== candidate workflow state (Admin Review workspace, PR-A) ===\n");

// --- computeCandidateWorkflowState: review outcome takes precedence -------
// over duplicate-check state, regardless of what that state is.

const allDuplicateStates: DuplicateCheckDisplayState[] = [
  "no_existing_claims",
  "not_checked",
  "in_progress",
  "stale",
  "failed",
  "succeeded",
];

for (const duplicateState of allDuplicateStates) {
  assert(
    computeCandidateWorkflowState({ action: "approve" }, duplicateState) === "approved",
    `review action 'approve' maps to 'approved' regardless of duplicate-check state ('${duplicateState}')`
  );
  assert(
    computeCandidateWorkflowState({ action: "link_existing_claim" }, duplicateState) === "linked",
    `review action 'link_existing_claim' maps to 'linked' regardless of duplicate-check state ('${duplicateState}')`
  );
  assert(
    computeCandidateWorkflowState({ action: "reject" }, duplicateState) === "rejected",
    `review action 'reject' maps to 'rejected' regardless of duplicate-check state ('${duplicateState}')`
  );
}

// --- computeCandidateWorkflowState: no review yet -- duplicate-check ------
// state decides.

assert(
  computeCandidateWorkflowState(null, "failed") === "failed",
  "no review + duplicate-check 'failed' maps to 'failed'"
);
assert(
  computeCandidateWorkflowState(null, "succeeded") === "duplicate_check_complete",
  "no review + duplicate-check 'succeeded' maps to 'duplicate_check_complete'"
);
assert(
  computeCandidateWorkflowState(null, "no_existing_claims") === "unchecked",
  "no review + duplicate-check 'no_existing_claims' maps to 'unchecked'"
);
assert(
  computeCandidateWorkflowState(null, "not_checked") === "unchecked",
  "no review + duplicate-check 'not_checked' maps to 'unchecked'"
);
assert(
  computeCandidateWorkflowState(null, "in_progress") === "unchecked",
  "no review + duplicate-check 'in_progress' maps to 'unchecked'"
);
assert(
  computeCandidateWorkflowState(null, "stale") === "unchecked",
  "no review + duplicate-check 'stale' maps to 'unchecked'"
);

// --- isResolvedWorkflowState -------------------------------------------

const resolvedStates: CandidateWorkflowState[] = ["approved", "linked", "rejected"];
const unresolvedStates: CandidateWorkflowState[] = ["unchecked", "duplicate_check_complete", "failed"];

for (const state of resolvedStates) {
  assert(isResolvedWorkflowState(state), `isResolvedWorkflowState('${state}') === true`);
}
for (const state of unresolvedStates) {
  assert(!isResolvedWorkflowState(state), `isResolvedWorkflowState('${state}') === false`);
}

// --- orderWorkspaceCandidatesUnresolvedFirst: stable partition -------------

{
  const input = [
    { id: "a", workflowState: "approved" as CandidateWorkflowState },
    { id: "b", workflowState: "unchecked" as CandidateWorkflowState },
    { id: "c", workflowState: "rejected" as CandidateWorkflowState },
    { id: "d", workflowState: "duplicate_check_complete" as CandidateWorkflowState },
    { id: "e", workflowState: "failed" as CandidateWorkflowState },
    { id: "f", workflowState: "linked" as CandidateWorkflowState },
  ];
  const ordered = orderWorkspaceCandidatesUnresolvedFirst(input);
  assert(
    ordered.map((c) => c.id).join(",") === "b,d,e,a,c,f",
    "unresolved candidates (b, d, e) sort before resolved candidates (a, c, f), each group keeping its original relative order"
  );
  assert(
    input.map((c) => c.id).join(",") === "a,b,c,d,e,f",
    "orderWorkspaceCandidatesUnresolvedFirst does not mutate its input array"
  );
}

{
  const allResolved = [
    { id: "x", workflowState: "approved" as CandidateWorkflowState },
    { id: "y", workflowState: "rejected" as CandidateWorkflowState },
  ];
  const ordered = orderWorkspaceCandidatesUnresolvedFirst(allResolved);
  assert(ordered.map((c) => c.id).join(",") === "x,y", "an all-resolved list keeps its original order unchanged");
}

// --- selectWorkspaceCandidate: deterministic default selection -----------

interface TestCandidate {
  aiResultId: number;
  candidateIndex: number;
  workflowState: CandidateWorkflowState;
  label: string;
}

{
  const candidates: TestCandidate[] = [
    { aiResultId: 1, candidateIndex: 0, workflowState: "unchecked", label: "first-unresolved" },
    { aiResultId: 1, candidateIndex: 1, workflowState: "approved", label: "second-resolved" },
  ];
  const selected = selectWorkspaceCandidate(candidates, { aiResultId: null, candidateIndex: null });
  assert(
    selected?.label === "first-unresolved",
    "with no requested selection, the first unresolved candidate is selected"
  );
}

{
  const candidates: TestCandidate[] = [
    { aiResultId: 1, candidateIndex: 0, workflowState: "unchecked", label: "unresolved" },
    { aiResultId: 1, candidateIndex: 1, workflowState: "approved", label: "requested-resolved" },
  ];
  const selected = selectWorkspaceCandidate(candidates, { aiResultId: 1, candidateIndex: 1 });
  assert(
    selected?.label === "requested-resolved",
    "a valid requested aiResultId+candidateIndex is honored even if it is not the first unresolved candidate"
  );
}

{
  const candidates: TestCandidate[] = [
    { aiResultId: 1, candidateIndex: 0, workflowState: "approved", label: "only-resolved" },
  ];
  const selected = selectWorkspaceCandidate(candidates, { aiResultId: null, candidateIndex: null });
  assert(
    selected?.label === "only-resolved",
    "when every candidate is resolved, the first candidate at all is selected (rule 3)"
  );
}

{
  const candidates: TestCandidate[] = [
    { aiResultId: 1, candidateIndex: 0, workflowState: "unchecked", label: "real-candidate" },
  ];
  const selected = selectWorkspaceCandidate(candidates, { aiResultId: 999, candidateIndex: 999 });
  assert(
    selected?.label === "real-candidate",
    "a stale/invalid requested aiResultId+candidateIndex (matching nothing) falls through to the default rule instead of throwing or selecting nothing"
  );
}

{
  const selected = selectWorkspaceCandidate([] as TestCandidate[], { aiResultId: 1, candidateIndex: 0 });
  assert(selected === null, "an empty candidate list selects null (clean empty state), even with a requested selection");
}

{
  // NaN is what Number(undefined) / Number("") produce -- a page.tsx
  // reading an absent search param must not accidentally match candidate
  // index 0 or similar via loose coercion.
  const candidates: TestCandidate[] = [
    { aiResultId: 1, candidateIndex: 0, workflowState: "unchecked", label: "candidate-zero" },
  ];
  const selected = selectWorkspaceCandidate(candidates, { aiResultId: Number.NaN, candidateIndex: Number.NaN });
  assert(
    selected?.label === "candidate-zero",
    "NaN requested identifiers never accidentally match a real candidate via ===, and fall through safely"
  );
}

console.log(failures === 0 ? "\nAll candidate workflow state checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
