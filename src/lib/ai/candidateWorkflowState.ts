/**
 * Admin Review workspace (PR-A). Pure presentation-state logic for the
 * candidate review workspace introduced in this PR -- no database, no
 * network, no React import. Same shape/rationale as
 * extractionActionability.ts and duplicateCheckActionability.ts: kept in
 * its own module so it is checkable in isolation, and so the workspace
 * components (CandidateList.tsx, CandidateDetail.tsx) consume a single
 * source of truth for "what state is this candidate in" instead of each
 * re-deriving it from raw job/review data.
 *
 * IMPORTANT: everything in this file is a PRESENTATION/workflow label. It
 * is never persisted, and it does not change the meaning of any existing
 * underlying state (ai_jobs status, claim_proposal_reviews rows,
 * admin_decisions rows). A candidate's true state of record remains
 * exactly what it was before this PR -- this module only decides which
 * one label the UI shows for it.
 */
import type { DuplicateCheckDisplayState } from "./duplicateCheckActionability";

export type CandidateReviewAction = "approve" | "reject" | "link_existing_claim";

export interface CandidateReviewOutcome {
  action: CandidateReviewAction;
}

/**
 * The six presentation states named in the approved PR-A spec. Precedence
 * (locked, matches the existing precedent already established in
 * duplicateCheckActionability.ts's header comment -- a reviewed candidate
 * bypasses duplicate-check state entirely):
 *   1. review outcome, if one exists -- approved / linked / rejected
 *   2. otherwise, the duplicate-check state -- failed / duplicate_check_complete / unchecked
 */
export type CandidateWorkflowState =
  | "unchecked"
  | "duplicate_check_complete"
  | "approved"
  | "linked"
  | "rejected"
  | "failed";

export function computeCandidateWorkflowState(
  review: CandidateReviewOutcome | null,
  duplicateState: DuplicateCheckDisplayState
): CandidateWorkflowState {
  if (review) {
    if (review.action === "approve") return "approved";
    if (review.action === "link_existing_claim") return "linked";
    return "rejected";
  }
  // no_existing_claims / not_checked / in_progress / stale all collapse to
  // "unchecked" here -- this workspace's six-state model does not need to
  // distinguish them; duplicateCheckActionability.ts's own six-state model
  // (used inside CandidateDetail for the actionable button itself) still
  // does, unchanged.
  if (duplicateState === "failed") return "failed";
  if (duplicateState === "succeeded") return "duplicate_check_complete";
  return "unchecked";
}

/** Resolved = a human decision has already been recorded for this candidate. */
export function isResolvedWorkflowState(state: CandidateWorkflowState): boolean {
  return state === "approved" || state === "linked" || state === "rejected";
}

export interface WorkspaceCandidateIdentity {
  aiResultId: number;
  candidateIndex: number;
  workflowState: CandidateWorkflowState;
}

/**
 * Stable partition: unresolved candidates first, resolved candidates
 * after, preserving each group's original relative order. Presentation
 * ordering only -- nothing is hidden or removed (Array.prototype.sort is
 * guaranteed stable since Node 12 / ES2019, so this never reorders within
 * a group).
 */
export function orderWorkspaceCandidatesUnresolvedFirst<T extends { workflowState: CandidateWorkflowState }>(
  candidates: T[]
): T[] {
  return [...candidates].sort(
    (a, b) => Number(isResolvedWorkflowState(a.workflowState)) - Number(isResolvedWorkflowState(b.workflowState))
  );
}

export interface RequestedCandidateSelection {
  aiResultId: number | null;
  candidateIndex: number | null;
}

/**
 * Deterministic default-selection rule (locked in the approved PR-A
 * spec):
 *   1. if aiResultId+candidateIndex identify a candidate actually present
 *      in this list, select it;
 *   2. otherwise, the first unresolved candidate;
 *   3. otherwise, the first candidate at all;
 *   4. otherwise (empty list), null.
 *
 * Deliberately tolerant of bad input: an invalid, stale, or
 * out-of-range requested pair simply fails the `.find()` below and falls
 * through to rule 2 -- this function never throws and never selects
 * anything other than a real member of `candidates`. `candidates` should
 * already be in the caller's intended display order (e.g. the output of
 * orderWorkspaceCandidatesUnresolvedFirst) -- this function does not sort.
 */
export function selectWorkspaceCandidate<T extends WorkspaceCandidateIdentity>(
  candidates: T[],
  requested: RequestedCandidateSelection
): T | null {
  if (candidates.length === 0) return null;

  if (requested.aiResultId !== null && requested.candidateIndex !== null) {
    const requestedMatch = candidates.find(
      (candidate) => candidate.aiResultId === requested.aiResultId && candidate.candidateIndex === requested.candidateIndex
    );
    if (requestedMatch) return requestedMatch;
  }

  const firstUnresolved = candidates.find((candidate) => !isResolvedWorkflowState(candidate.workflowState));
  if (firstUnresolved) return firstUnresolved;

  return candidates[0];
}
