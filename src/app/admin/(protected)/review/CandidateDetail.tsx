import type { PersistedDuplicateMatch, DetectDuplicatesJobForDisplay } from "@/db/queries/admin";
import type { CandidateWorkflowState } from "@/lib/ai/candidateWorkflowState";
import {
  computeDuplicateCheckDisplayState,
  canTriggerDuplicateCheck,
  duplicateCheckButtonLabel,
  type DuplicateCheckDisplayState,
} from "@/lib/ai/duplicateCheckActionability";
import { developmentOutcomeDisplay, informationTypeLabel, investigationStatusDisplay } from "@/lib/statusDisplay";
import {
  approveClaimProposalAction,
  rejectClaimProposalAction,
  runDetectDuplicatesAction,
  resolveAsExistingClaimAction,
} from "./actions";
import { WORKFLOW_STATE_LABEL, WORKFLOW_STATE_CLASS } from "./CandidateList";

/**
 * Admin Review workspace (PR-A). Everything needed to review ONE
 * extracted claim candidate: full statement/excerpt/reasoning, the
 * duplicate-check box (with matches and "use existing claim" actions),
 * and the approve/reject review form. This is the same content that
 * previously rendered inline for every unreviewed candidate in a single
 * long page -- relocated here, unchanged in substance, so exactly one
 * candidate's full detail is visible at a time.
 *
 * No mutation logic lives here or changed here: every <form action=...>
 * below still calls the exact same server action from ./actions.ts, which
 * still re-validates everything server-side from persisted state. The
 * aiResultId/candidateIndex hidden inputs (and the query-string values
 * that select this candidate) are navigation/display context only --
 * never treated as authority by the actions themselves.
 */

export interface CandidateDetailData {
  aiResultId: number;
  candidateIndex: number;
  sourceItemId: number;
  sourceItemTitle: string | null;
  sourceItemUrl: string;
  statement: string;
  informationType: string;
  supportingExcerpt: string;
  confidence: number;
  reasoning: string;
  workflowState: CandidateWorkflowState;
  review: {
    action: "approve" | "reject" | "link_existing_claim";
    notes: string | null;
    materializedClaimId: number | null;
  } | null;
}

export interface CandidateDetailFeedback {
  proposalStatus?: string;
  proposalError?: string;
  claimId?: string;
  duplicateStatus?: string;
  duplicateError?: string;
}

function suggestedSlug(statement: string, candidateIndex: number): string {
  const slug = statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220)
    .replace(/-+$/g, "");
  return slug || `extracted-claim-${candidateIndex + 1}`;
}

// Preserves the original six-state duplicate-check color granularity
// (distinct from WORKFLOW_STATE_CLASS's coarser three-color map, which
// collapses no_existing_claims/not_checked/in_progress/stale into a
// single "unchecked" presentation state) -- this badge is specifically
// about duplicate-check progress, not the overall candidate workflow
// state shown in the header chip above.
const DUPLICATE_STATUS_CLASS: Record<DuplicateCheckDisplayState, string> = {
  no_existing_claims: "text-ink-600",
  not_checked: "text-ink-600",
  in_progress: "text-accent-brass",
  stale: "text-signal-disproven",
  failed: "text-signal-disproven",
  succeeded: "text-signal-confirmed",
};

const reviewInputClass = "w-full border border-hairline bg-bg-void px-2 py-1 text-xs text-ink-100 focus-visible:border-accent-brass";
const reviewApproveClass = "border border-signal-confirmed px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-signal-confirmed hover:bg-signal-confirmed hover:text-bg-void";
const reviewRejectClass = "mt-2 border border-signal-disproven px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-signal-disproven hover:bg-signal-disproven hover:text-bg-void";

function ReviewField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</label>
      {children}
    </div>
  );
}

export function CandidateDetail({
  candidate,
  hasExistingClaims,
  duplicateJob,
  duplicateMatches,
  topics,
  feedback,
  now,
}: {
  candidate: CandidateDetailData | null;
  hasExistingClaims: boolean;
  duplicateJob: DetectDuplicatesJobForDisplay | null;
  duplicateMatches: PersistedDuplicateMatch[] | null;
  topics: { id: number; name: string }[];
  feedback: CandidateDetailFeedback;
  now: Date;
}) {
  if (!candidate) {
    return (
      <div className="self-start border border-hairline p-4 text-sm text-ink-600 lg:sticky lg:top-6">
        Select a candidate from the list to review it here.
      </div>
    );
  }

  const duplicateState: DuplicateCheckDisplayState = computeDuplicateCheckDisplayState(hasExistingClaims, duplicateJob, now);
  const showDuplicateAction = !candidate.review && canTriggerDuplicateCheck(duplicateState);
  const duplicateLabel = showDuplicateAction ? duplicateCheckButtonLabel(duplicateState) : null;

  return (
    <div className="self-start border border-hairline p-4 text-sm lg:sticky lg:top-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-600">
            {candidate.sourceItemTitle ?? candidate.sourceItemUrl} · source item #{candidate.sourceItemId}
          </p>
        </div>
        <span className={`font-mono text-xs uppercase tracking-wide ${WORKFLOW_STATE_CLASS[candidate.workflowState]}`}>
          {WORKFLOW_STATE_LABEL[candidate.workflowState]}
        </span>
      </div>

      {feedback.proposalError && (
        <p className="mt-3 border border-signal-disproven/50 px-3 py-2 text-xs text-signal-disproven">{feedback.proposalError}</p>
      )}
      {feedback.proposalStatus && (
        <p className="mt-3 text-xs text-ink-400">
          Claim proposal review: <span className="font-mono text-ink-100">{feedback.proposalStatus}</span>
          {feedback.proposalStatus === "approved" && feedback.claimId && <> — claim #{feedback.claimId} created.</>}
          {feedback.proposalStatus === "linked_existing_claim" && feedback.claimId && <> — linked to existing claim #{feedback.claimId}.</>}
        </p>
      )}
      {feedback.duplicateError && (
        <p className="mt-3 border border-signal-disproven/50 px-3 py-2 text-xs text-signal-disproven">{feedback.duplicateError}</p>
      )}
      {feedback.duplicateStatus && (
        <p className="mt-3 text-xs text-ink-400">
          Duplicate check: <span className="font-mono text-ink-100">{feedback.duplicateStatus}</span>
        </p>
      )}

      <p className="mt-4 text-ink-100">{candidate.statement}</p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
        {candidate.informationType} · confidence {candidate.confidence.toFixed(2)}
      </p>
      <p className="mt-2 text-xs text-ink-400">"{candidate.supportingExcerpt}"</p>
      <p className="mt-1 text-xs text-ink-600">{candidate.reasoning}</p>

      {candidate.review ? (
        <p
          className={`mt-4 border-l-2 pl-2 text-xs ${
            candidate.review.action === "reject" ? "border-signal-disproven text-signal-disproven" : "border-signal-confirmed text-signal-confirmed"
          }`}
        >
          {candidate.review.action === "approve"
            ? "Approved"
            : candidate.review.action === "link_existing_claim"
              ? "Resolved to existing claim"
              : "Rejected"}
          {candidate.review.materializedClaimId && <> — claim #{candidate.review.materializedClaimId}</>}
          {candidate.review.notes && <>: {candidate.review.notes}</>}
        </p>
      ) : (
        <>
          <div className="mt-4 border border-hairline p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Duplicate check</span>
              <span className={`font-mono text-[10px] uppercase tracking-wide ${DUPLICATE_STATUS_CLASS[duplicateState]}`}>
                {duplicateState === "no_existing_claims"
                  ? "No existing claims yet to compare against"
                  : duplicateState === "not_checked"
                    ? "Not yet checked for duplicates"
                    : duplicateState === "in_progress"
                      ? "Checking for duplicates…"
                      : duplicateState === "stale"
                        ? "Stale — recovery available"
                        : duplicateState === "failed"
                          ? "Duplicate check failed"
                          : "Duplicate check complete"}
              </span>
            </div>

            {duplicateState === "stale" && (
              <p className="mt-2 text-ink-600">
                An in-flight attempt started but never reached a terminal outcome within the staleness window — safe
                to reclaim and retry.
              </p>
            )}
            {duplicateState === "failed" && duplicateJob?.error && <p className="mt-2 text-signal-disproven">{duplicateJob.error}</p>}

            {duplicateMatches && duplicateMatches.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-ink-600">Possible matches — advisory only, review before acting:</p>
                {duplicateMatches.map((match) => (
                  <div key={match.existingClaimId} className="border-l-2 border-accent-brass/50 pl-2">
                    <p className="text-ink-100">
                      Claim #{match.existingClaimId} · confidence {match.confidence.toFixed(2)}
                    </p>
                    <p className="mt-1 text-ink-600">{match.reasoning}</p>
                    <form action={resolveAsExistingClaimAction} className="mt-2 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="aiResultId" value={candidate.aiResultId} />
                      <input type="hidden" name="candidateIndex" value={candidate.candidateIndex} />
                      <input type="hidden" name="existingClaimId" value={match.existingClaimId} />
                      <input
                        name="reason"
                        required
                        placeholder="Reason for using this existing claim"
                        className={`${reviewInputClass} flex-1`}
                      />
                      <button type="submit" className={reviewApproveClass}>
                        Use existing claim #{match.existingClaimId}
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}
            {duplicateMatches && duplicateMatches.length === 0 && duplicateState === "succeeded" && (
              <p className="mt-2 text-ink-600">No likely duplicate found.</p>
            )}

            {showDuplicateAction && duplicateLabel && (
              <form action={runDetectDuplicatesAction} className="mt-3">
                <input type="hidden" name="aiResultId" value={candidate.aiResultId} />
                <input type="hidden" name="candidateIndex" value={candidate.candidateIndex} />
                <button
                  type="submit"
                  className="border border-accent-brass px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
                >
                  {duplicateLabel}
                </button>
              </form>
            )}
          </div>

          <details className="mt-4 border border-hairline p-3">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-accent-brass">
              Review this candidate
            </summary>
            <p className="mt-3 text-ink-600">
              The quoted source text is fixed provenance. You may edit the proposed claim metadata before approval.
            </p>

            <form action={approveClaimProposalAction} className="mt-3 space-y-3">
              <input type="hidden" name="aiResultId" value={candidate.aiResultId} />
              <input type="hidden" name="candidateIndex" value={candidate.candidateIndex} />
              <input type="hidden" name="projectId" value="1" />
              <ReviewField label="Canonical statement">
                <textarea name="statement" required rows={3} defaultValue={candidate.statement} className={reviewInputClass} />
              </ReviewField>
              <ReviewField label="Slug">
                <input name="slug" required defaultValue={suggestedSlug(candidate.statement, candidate.candidateIndex)} className={reviewInputClass} />
              </ReviewField>
              <ReviewField label="Information type">
                <select name="informationType" required defaultValue={candidate.informationType} className={reviewInputClass}>
                  {Object.entries(informationTypeLabel).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </ReviewField>
              <ReviewField label="First reported date (optional)">
                <input type="date" name="firstReportedAt" className={reviewInputClass} />
              </ReviewField>
              <ReviewField label="Topics">
                <select name="topicIds" multiple className={`${reviewInputClass} h-28`}>
                  {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
                </select>
              </ReviewField>
              <ReviewField label="Initial investigation status">
                <select name="initialInvestigationStatus" defaultValue="unverified" className={reviewInputClass}>
                  {Object.entries(investigationStatusDisplay).map(([value, display]) => <option key={value} value={value}>{display.label}</option>)}
                </select>
              </ReviewField>
              <ReviewField label="Initial development outcome">
                <select name="initialDevelopmentOutcome" defaultValue="unknown" className={reviewInputClass}>
                  {Object.entries(developmentOutcomeDisplay).map(([value, display]) => <option key={value} value={value}>{display.label}</option>)}
                </select>
              </ReviewField>
              <ReviewField label="Reason for approval and initial statuses">
                <textarea name="reason" required rows={2} defaultValue="Approved after review of the quoted source material." className={reviewInputClass} />
              </ReviewField>
              <button type="submit" className={reviewApproveClass}>Approve and create claim</button>
            </form>

            <form action={rejectClaimProposalAction} className="mt-3 border-t border-hairline pt-3">
              <input type="hidden" name="aiResultId" value={candidate.aiResultId} />
              <input type="hidden" name="candidateIndex" value={candidate.candidateIndex} />
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Rejection reason</label>
              <textarea name="notes" required rows={2} className={reviewInputClass} />
              <button type="submit" className={reviewRejectClass}>Reject candidate</button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
