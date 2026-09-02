import Link from "next/link";
import type { CandidateWorkflowState } from "@/lib/ai/candidateWorkflowState";

/**
 * Admin Review workspace (PR-A). Compact, list-only presentation of every
 * extracted claim candidate across all source items -- title/source item,
 * a short statement excerpt, and one state chip. No form controls, no
 * duplicate-check detail, no review actions live here; selecting a row
 * navigates (via a plain server-rendered link, no client state) to
 * ?aiResultId=..&candidateIndex=.., which CandidateDetail reads to render
 * the full workspace for that one candidate.
 *
 * Candidates are expected to already be in the caller's intended display
 * order (unresolved-first) -- this component does not sort.
 */

export const WORKFLOW_STATE_LABEL: Record<CandidateWorkflowState, string> = {
  unchecked: "Unchecked",
  duplicate_check_complete: "Duplicate check complete",
  approved: "Approved",
  linked: "Linked to existing claim",
  rejected: "Rejected",
  failed: "Duplicate check failed",
};

export const WORKFLOW_STATE_CLASS: Record<CandidateWorkflowState, string> = {
  unchecked: "text-ink-600",
  duplicate_check_complete: "text-accent-brass",
  approved: "text-signal-confirmed",
  linked: "text-signal-confirmed",
  rejected: "text-signal-disproven",
  failed: "text-signal-disproven",
};

export interface CandidateListRow {
  aiResultId: number;
  candidateIndex: number;
  sourceItemTitle: string | null;
  sourceItemUrl: string;
  statement: string;
  workflowState: CandidateWorkflowState;
}

const STATEMENT_PREVIEW_LENGTH = 90;

function previewStatement(statement: string): string {
  if (statement.length <= STATEMENT_PREVIEW_LENGTH) return statement;
  return `${statement.slice(0, STATEMENT_PREVIEW_LENGTH).trimEnd()}…`;
}

export function CandidateList({
  candidates,
  selected,
}: {
  candidates: CandidateListRow[];
  selected: { aiResultId: number; candidateIndex: number } | null;
}) {
  if (candidates.length === 0) {
    return (
      <p className="border border-hairline p-4 text-sm text-ink-600">
        No claim candidates yet. Candidates appear here once extract_claims succeeds for a source
        item with extractable content.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-hairline border border-hairline text-sm">
      {candidates.map((candidate) => {
        const isSelected =
          selected !== null &&
          selected.aiResultId === candidate.aiResultId &&
          selected.candidateIndex === candidate.candidateIndex;

        return (
          <li key={`${candidate.aiResultId}:${candidate.candidateIndex}`}>
            <Link
              href={`/admin/review?aiResultId=${candidate.aiResultId}&candidateIndex=${candidate.candidateIndex}`}
              scroll={false}
              className={`block p-3 hover:bg-bg-panel-raised ${isSelected ? "border-l-2 border-accent-brass bg-bg-panel-raised" : "border-l-2 border-transparent"}`}
            >
              <p className="truncate font-mono text-[10px] uppercase tracking-wide text-ink-600">
                {candidate.sourceItemTitle ?? candidate.sourceItemUrl}
              </p>
              <p className="mt-1 text-ink-100">{previewStatement(candidate.statement)}</p>
              <span className={`mt-1 block font-mono text-[10px] uppercase tracking-wide ${WORKFLOW_STATE_CLASS[candidate.workflowState]}`}>
                {WORKFLOW_STATE_LABEL[candidate.workflowState]}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
