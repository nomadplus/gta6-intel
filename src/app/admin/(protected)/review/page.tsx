import Link from "next/link";
import {
  listSourceItemClassificationStatus,
  listSourceItemExtractionStatus,
  listTopicsForAdmin,
  getLatestDetectDuplicatesJob,
  getLatestDetectDuplicatesMatches,
  countClaimsForProject,
  type PersistedDuplicateMatch,
} from "@/db/queries/admin";
import { adminDb } from "@/db/adminClient";
import { computeClassificationDisplayStatus, type ClassificationDisplayStatus } from "@/lib/ai/classificationRecoveryLifecycle";
import { computeExtractionDisplayStatus, type ExtractionDisplayStatus } from "@/lib/ai/extractClaimsRecoveryLifecycle";
import { canTriggerExtraction, extractionButtonLabel } from "@/lib/ai/extractionActionability";
import { computeDuplicateCheckDisplayState } from "@/lib/ai/duplicateCheckActionability";
import { DUPLICATE_CHECK_DEFAULT_PROJECT_ID } from "@/lib/ai/operations/detectDuplicatesTrigger";
import {
  computeCandidateWorkflowState,
  orderWorkspaceCandidatesUnresolvedFirst,
  selectWorkspaceCandidate,
  type CandidateWorkflowState,
} from "@/lib/ai/candidateWorkflowState";
import { CandidateList, type CandidateListRow } from "./CandidateList";
import { CandidateDetail, type CandidateDetailData } from "./CandidateDetail";
import { runClassificationRecoveryAction, runExtractClaimsAction } from "./actions";

const STATUS_LABEL: Record<ClassificationDisplayStatus, string> = {
  unclassified: "Unclassified",
  in_progress: "In progress",
  stale: "Stale — recovery available",
  failed: "Failed",
  succeeded: "Succeeded",
};

const STATUS_CLASS: Record<ClassificationDisplayStatus, string> = {
  unclassified: "text-ink-600",
  in_progress: "text-accent-brass",
  stale: "text-signal-disproven",
  failed: "text-signal-disproven",
  succeeded: "text-signal-confirmed",
};

function recoveryButtonLabel(status: ClassificationDisplayStatus): string {
  if (status === "failed") return "Retry classification";
  if (status === "stale") return "Recover & retry";
  return "Run classification";
}

const EXTRACTION_STATUS_LABEL: Record<ExtractionDisplayStatus, string> = {
  unextracted: "Not yet extracted",
  in_progress: "In progress",
  stale: "Stale — recovery available",
  failed: "Failed",
  succeeded: "Succeeded",
};

const EXTRACTION_STATUS_CLASS: Record<ExtractionDisplayStatus, string> = {
  unextracted: "text-ink-600",
  in_progress: "text-accent-brass",
  stale: "text-signal-disproven",
  failed: "text-signal-disproven",
  succeeded: "text-signal-confirmed",
};

/** Parses a searchParams string value into a finite number, or null for anything else (absent, empty, non-numeric). Never throws. */
function parseIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface WorkspaceCandidate extends CandidateDetailData {
  candidateStatementPreview: string;
}

export default async function AdminReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    recoveryStatus?: string;
    recoveryError?: string;
    extractStatus?: string;
    extractError?: string;
    proposalError?: string;
    proposalStatus?: string;
    claimId?: string;
    sourceItemId?: string;
    duplicateStatus?: string;
    duplicateError?: string;
    aiResultId?: string;
    candidateIndex?: string;
  }>;
}) {
  const {
    recoveryStatus,
    recoveryError,
    extractStatus,
    extractError,
    proposalError,
    proposalStatus,
    claimId,
    sourceItemId,
    duplicateStatus,
    duplicateError,
    aiResultId: aiResultIdParam,
    candidateIndex: candidateIndexParam,
  } = await searchParams;
  const classificationRows = await listSourceItemClassificationStatus();
  const extractionRows = await listSourceItemExtractionStatus();
  const topics = await listTopicsForAdmin();
  const now = new Date();

  // Phase 5 PR 6 (unchanged by PR-A): one project-wide fact (is there
  // anything at all to compare a duplicate check against), computed once
  // for the whole page rather than per candidate, plus each unreviewed
  // candidate's own latest detect_duplicates job/matches. Deliberately
  // per-candidate reads here rather than a batched LATERAL-join query --
  // see the original PR 6 comment this preserves verbatim below. PR-A
  // does not change this fetching strategy; it only changes how the
  // results are laid out on the page.
  const hasExistingClaims = (await countClaimsForProject(adminDb, DUPLICATE_CHECK_DEFAULT_PROJECT_ID)) > 0;
  const duplicateCheckDataByCandidate = new Map<
    string,
    { job: Awaited<ReturnType<typeof getLatestDetectDuplicatesJob>>; matches: PersistedDuplicateMatch[] | null }
  >();
  for (const row of extractionRows) {
    if (row.aiResultId === null) continue;
    for (const candidate of row.candidates) {
      if (candidate.review) continue;
      const job = await getLatestDetectDuplicatesJob(adminDb, row.aiResultId, candidate.candidateIndex);
      const matches = await getLatestDetectDuplicatesMatches(adminDb, row.aiResultId, candidate.candidateIndex);
      duplicateCheckDataByCandidate.set(`${row.aiResultId}:${candidate.candidateIndex}`, { job, matches });
    }
  }

  // Admin Review workspace (PR-A): flatten every extracted candidate
  // across all source items into one list, each carrying its own
  // presentation-only six-state workflow label (candidateWorkflowState.ts)
  // -- this replaces the previous per-source-item inline candidate
  // rendering with a single cross-source-item review queue.
  const workspaceCandidatesUnordered: WorkspaceCandidate[] = [];
  for (const row of extractionRows) {
    if (row.aiResultId === null) continue;
    const aiResultId = row.aiResultId;
    for (const candidate of row.candidates) {
      const duplicateData = duplicateCheckDataByCandidate.get(`${aiResultId}:${candidate.candidateIndex}`);
      const duplicateState = computeDuplicateCheckDisplayState(hasExistingClaims, duplicateData?.job ?? null, now);
      const workflowState: CandidateWorkflowState = computeCandidateWorkflowState(candidate.review, duplicateState);
      workspaceCandidatesUnordered.push({
        aiResultId,
        candidateIndex: candidate.candidateIndex,
        sourceItemId: row.sourceItemId,
        sourceItemTitle: row.title,
        sourceItemUrl: row.url,
        statement: candidate.statement,
        candidateStatementPreview: candidate.statement,
        informationType: candidate.informationType,
        supportingExcerpt: candidate.supportingExcerpt,
        confidence: candidate.confidence,
        reasoning: candidate.reasoning,
        review: candidate.review,
        workflowState,
      });
    }
  }
  const workspaceCandidates = orderWorkspaceCandidatesUnresolvedFirst(workspaceCandidatesUnordered);

  const requestedAiResultId = parseIntOrNull(aiResultIdParam);
  const requestedCandidateIndex = parseIntOrNull(candidateIndexParam);
  const selectedCandidate = selectWorkspaceCandidate(workspaceCandidates, {
    aiResultId: requestedAiResultId,
    candidateIndex: requestedCandidateIndex,
  });

  // Scoped feedback (locked in the approved PR-A spec): only show the
  // proposal/duplicate-check outcome banner when the requested identity in
  // the URL exactly matches the candidate actually selected -- a stale or
  // invalid link that fell back to a different candidate (see
  // selectWorkspaceCandidate) must never attach someone else's feedback to
  // the wrong candidate.
  const feedbackMatchesSelection =
    selectedCandidate !== null &&
    requestedAiResultId === selectedCandidate.aiResultId &&
    requestedCandidateIndex === selectedCandidate.candidateIndex;

  const selectedDuplicateData = selectedCandidate
    ? duplicateCheckDataByCandidate.get(`${selectedCandidate.aiResultId}:${selectedCandidate.candidateIndex}`) ?? null
    : null;

  const listRows: CandidateListRow[] = workspaceCandidates.map((candidate) => ({
    aiResultId: candidate.aiResultId,
    candidateIndex: candidate.candidateIndex,
    sourceItemTitle: candidate.sourceItemTitle,
    sourceItemUrl: candidate.sourceItemUrl,
    statement: candidate.candidateStatementPreview,
    workflowState: candidate.workflowState,
  }));

  return (
    <div className="max-w-6xl">
      <h1 className="font-display text-3xl italic text-ink-100">AI / Admin Review</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Live classify_relevance (Phase 5 PR 3) and extract_claims (Phase 5 PR 4) processing queues,
        plus a candidate review workspace below. Both AI operations produce advisory output only —
        a classification or an extracted claim candidate is a recommendation for human review, never
        an automatic change to any claim, evidence, or source-item record. Extraction candidates can
        only become claims through an explicit editor review; accepting one records the decision and
        its source provenance. For the full historical audit log, see{" "}
        <Link href="/admin/review/history" className="text-accent-brass hover:underline">
          AI Review History
        </Link>
        .
      </p>

      {recoveryError && (
        <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
          {recoveryError}
        </p>
      )}
      {recoveryStatus && (
        <p className="mt-4 text-sm text-ink-400">
          Classification recovery for source item #{sourceItemId}:{" "}
          <span className="font-mono text-ink-100">{recoveryStatus}</span>
        </p>
      )}
      {extractError && (
        <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
          {extractError}
        </p>
      )}
      {extractStatus && (
        <p className="mt-4 text-sm text-ink-400">
          Claim extraction for source item #{sourceItemId}:{" "}
          <span className="font-mono text-ink-100">{extractStatus}</span>
        </p>
      )}

      <h2 className="mt-10 font-display text-xl italic text-ink-100">Source item classification status</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        classify_relevance status per source item (Phase 5 PR 3) — advisory metadata only. A
        classification, or a missing/failed/stale attempt, never hides, deletes, or mutates the
        underlying source item.
      </p>

      {classificationRows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">No source items yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline border border-hairline text-sm">
          {classificationRows.map((row) => {
            const status = computeClassificationDisplayStatus(
              row.jobId !== null && row.jobStatus !== null && row.jobCreatedAt !== null
                ? { status: row.jobStatus, createdAt: row.jobCreatedAt, startedAt: row.jobStartedAt }
                : null,
              now
            );
            const canRecover = status === "unclassified" || status === "stale" || status === "failed";

            return (
              <li key={row.sourceItemId} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-ink-100">{row.title ?? row.url}</p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                      source item #{row.sourceItemId}
                    </p>
                  </div>
                  <span className={`font-mono text-xs uppercase tracking-wide ${STATUS_CLASS[status]}`}>
                    {STATUS_LABEL[status]}
                  </span>
                </div>

                {status === "succeeded" && (
                  <p className="mt-2 text-xs text-ink-400">
                    {row.relevance ?? "—"} · confidence {row.confidence !== null ? row.confidence.toFixed(2) : "—"}
                    {row.reasoning && <> — {row.reasoning}</>}
                  </p>
                )}
                {status === "failed" && row.jobError && (
                  <p className="mt-2 text-xs text-signal-disproven">{row.jobError}</p>
                )}
                {status === "stale" && (
                  <p className="mt-2 text-xs text-ink-600">
                    An in-flight attempt started but never reached a terminal outcome within the
                    staleness window — safe to reclaim and retry.
                  </p>
                )}

                {canRecover && (
                  <form action={runClassificationRecoveryAction} className="mt-3">
                    <input type="hidden" name="sourceItemId" value={row.sourceItemId} />
                    <button
                      type="submit"
                      className="border border-accent-brass px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
                    >
                      {recoveryButtonLabel(status)}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mt-10 font-display text-xl italic text-ink-100">Claim extraction status</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        extract_claims status per source item (Phase 5 PR 4) — proposal only. A source item becomes
        eligible only once its <em>latest successful</em> classify_relevance result is exactly
        "relevant"; a never-classified, only-ever-failed, or currently-in-flight-with-no-prior-success
        item shows as ineligible below and cannot trigger extraction, even by direct request.
        Extracted candidates are reviewed in the workspace further down this page.
      </p>

      {extractionRows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">No source items yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline border border-hairline text-sm">
          {extractionRows.map((row) => {
            const eligible = row.latestSuccessfulRelevance === "relevant";
            const status = computeExtractionDisplayStatus(
              row.jobId !== null && row.jobStatus !== null && row.jobCreatedAt !== null
                ? { status: row.jobStatus, createdAt: row.jobCreatedAt, startedAt: row.jobStartedAt }
                : null,
              now
            );
            // Belt-and-braces UI gating: the actual enforcement is
            // triggerExtractClaims's own server-side eligibility check
            // (extractClaimsTrigger.ts), not this condition -- this only
            // decides whether to render an action control at all.
            const showAction = eligible && canTriggerExtraction(status);
            const label = showAction ? extractionButtonLabel(status) : null;

            return (
              <li key={row.sourceItemId} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-ink-100">{row.title ?? row.url}</p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                      source item #{row.sourceItemId}
                    </p>
                  </div>
                  <span className={`font-mono text-xs uppercase tracking-wide ${EXTRACTION_STATUS_CLASS[status]}`}>
                    {EXTRACTION_STATUS_LABEL[status]}
                  </span>
                </div>

                {!eligible && (
                  <p className="mt-2 text-xs text-ink-600">
                    Not eligible for extraction — latest successful classification is{" "}
                    <span className="font-mono">{row.latestSuccessfulRelevance ?? "none yet"}</span>, not "relevant".
                  </p>
                )}

                {eligible && status === "succeeded" && (
                  <div className="mt-2">
                    {row.candidates.length === 0 ? (
                      <p className="text-xs text-ink-600">
                        No extractable claims found.
                        {row.noExtractableClaimsNote && <> — {row.noExtractableClaimsNote}</>}
                      </p>
                    ) : (
                      <p className="text-xs text-ink-600">
                        {row.candidates.length} candidate{row.candidates.length === 1 ? "" : "s"} extracted —{" "}
                        <Link
                          href={`/admin/review?aiResultId=${row.aiResultId}&candidateIndex=${row.candidates[0].candidateIndex}`}
                          className="text-accent-brass hover:underline"
                        >
                          review in the workspace below
                        </Link>
                        .
                      </p>
                    )}
                  </div>
                )}

                {eligible && status === "failed" && row.jobError && (
                  <p className="mt-2 text-xs text-signal-disproven">{row.jobError}</p>
                )}
                {eligible && status === "stale" && (
                  <p className="mt-2 text-xs text-ink-600">
                    An in-flight attempt started but never reached a terminal outcome within the
                    staleness window — safe to reclaim and retry.
                  </p>
                )}

                {showAction && label && (
                  <form action={runExtractClaimsAction} className="mt-3">
                    <input type="hidden" name="sourceItemId" value={row.sourceItemId} />
                    <button
                      type="submit"
                      className="border border-accent-brass px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
                    >
                      {label}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 id="candidate-review-workspace" className="mt-10 font-display text-xl italic text-ink-100">Candidate review workspace</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Every extracted claim candidate across all source items, unresolved first. Select one to
        review its full detail, duplicate-check result, and approve / link / reject actions.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <CandidateList
          candidates={listRows}
          selected={selectedCandidate ? { aiResultId: selectedCandidate.aiResultId, candidateIndex: selectedCandidate.candidateIndex } : null}
        />
        <CandidateDetail
          candidate={selectedCandidate}
          hasExistingClaims={hasExistingClaims}
          duplicateJob={selectedDuplicateData?.job ?? null}
          duplicateMatches={selectedDuplicateData?.matches ?? null}
          topics={topics}
          feedback={
            feedbackMatchesSelection
              ? { proposalStatus, proposalError, claimId, duplicateStatus, duplicateError }
              : {}
          }
          now={now}
        />
      </div>
    </div>
  );
}
