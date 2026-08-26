import {
  listAiReviewRecords,
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
import { computeDuplicateCheckDisplayState, canTriggerDuplicateCheck, duplicateCheckButtonLabel, type DuplicateCheckDisplayState } from "@/lib/ai/duplicateCheckActionability";
import { DUPLICATE_CHECK_DEFAULT_PROJECT_ID } from "@/lib/ai/operations/detectDuplicatesTrigger";
import { developmentOutcomeDisplay, informationTypeLabel, investigationStatusDisplay } from "@/lib/statusDisplay";
import {
  approveClaimProposalAction,
  rejectClaimProposalAction,
  runClassificationRecoveryAction,
  runExtractClaimsAction,
  runDetectDuplicatesAction,
  resolveAsExistingClaimAction,
} from "./actions";

function suggestedSlug(statement: string, candidateIndex: number): string {
  const slug = statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220)
    .replace(/-+$/g, "");
  return slug || `extracted-claim-${candidateIndex + 1}`;
}

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

// Phase 5 PR 6: six-state duplicate-check display model (see
// duplicateCheckActionability.ts). no_existing_claims is distinct from
// not_checked -- a check has genuinely never run in either case, but
// no_existing_claims means running one would be pointless (and free),
// while not_checked means one is available and would cost something.
const DUPLICATE_STATUS_LABEL: Record<DuplicateCheckDisplayState, string> = {
  no_existing_claims: "No existing claims yet to compare against",
  not_checked: "Not yet checked for duplicates",
  in_progress: "Checking for duplicates…",
  stale: "Stale — recovery available",
  failed: "Duplicate check failed",
  succeeded: "Duplicate check complete",
};

const DUPLICATE_STATUS_CLASS: Record<DuplicateCheckDisplayState, string> = {
  no_existing_claims: "text-ink-600",
  not_checked: "text-ink-600",
  in_progress: "text-accent-brass",
  stale: "text-signal-disproven",
  failed: "text-signal-disproven",
  succeeded: "text-signal-confirmed",
};

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
    aiResultId: duplicateAiResultId,
    candidateIndex: duplicateCandidateIndex,
  } = await searchParams;
  const records = await listAiReviewRecords();
  const classificationRows = await listSourceItemClassificationStatus();
  const extractionRows = await listSourceItemExtractionStatus();
  const topics = await listTopicsForAdmin();
  const now = new Date();

  // Phase 5 PR 6: one project-wide fact (is there anything at all to
  // compare a duplicate check against), computed once for the whole
  // page rather than per candidate, plus each unreviewed candidate's own
  // latest detect_duplicates job/matches. Deliberately per-candidate
  // reads here rather than a batched LATERAL-join query (the pattern
  // listSourceItemExtractionStatus itself uses to avoid N+1) -- the
  // number of unreviewed candidates on this admin-only page is small
  // (at most MAX_EXTRACTED_CLAIMS=8 per source item), so this trades a
  // small, known amount of query fan-out for staying within this PR's
  // locked file-count scope; a batched query would be a reasonable
  // follow-up if this page's candidate volume ever grows materially.
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

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-3xl italic text-ink-100">AI / Admin Review</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Record of AI recommendations and the admin decisions made on them, plus the live
        classify_relevance (Phase 5 PR 3) and extract_claims (Phase 5 PR 4) processing queues below.
        Both AI operations produce advisory output only — a classification or an extracted claim
        candidate is a recommendation for human review, never an automatic change to any claim,
        evidence, or source-item record. Extraction candidates below can only become claims through
        an explicit editor review; accepting one records the decision and its source provenance.
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
      {proposalError && (
        <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
          {proposalError}
        </p>
      )}
      {proposalStatus && (
        <p className="mt-4 text-sm text-ink-400">
          Claim proposal review: <span className="font-mono text-ink-100">{proposalStatus}</span>
          {proposalStatus === "approved" && claimId && <> — claim #{claimId} created.</>}
          {proposalStatus === "linked_existing_claim" && claimId && <> — linked to existing claim #{claimId}.</>}
        </p>
      )}
      {duplicateError && (
        <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
          {duplicateError}
        </p>
      )}
      {duplicateStatus && (
        <p className="mt-4 text-sm text-ink-400">
          Duplicate check for candidate {duplicateCandidateIndex} of AI result #{duplicateAiResultId}:{" "}
          <span className="font-mono text-ink-100">{duplicateStatus}</span>
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

      <h2 className="mt-10 font-display text-xl italic text-ink-100">Claim extraction candidates</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        extract_claims status per source item (Phase 5 PR 4) — proposal only. A source item becomes
        eligible only once its <em>latest successful</em> classify_relevance result is exactly
        "relevant"; a never-classified, only-ever-failed, or currently-in-flight-with-no-prior-success
        item shows as ineligible below and cannot trigger extraction, even by direct request. Nothing
        here changes a claim automatically. An editor may review, edit, approve, or reject each
        candidate independently. Approval creates a claim and one supporting source citation in a
        single audited transaction; rejection creates no claim, evidence, or provenance record.
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
                  <div className="mt-2 space-y-2">
                    {row.candidates.length === 0 ? (
                      <p className="text-xs text-ink-600">
                        No extractable claims found.
                        {row.noExtractableClaimsNote && <> — {row.noExtractableClaimsNote}</>}
                      </p>
                    ) : (
                      row.candidates.map((candidate) => (
                        <div key={candidate.candidateIndex} className="border-l-2 border-hairline pl-3 text-xs text-ink-400">
                          <p className="text-ink-100">{candidate.statement}</p>
                          <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                            {candidate.informationType} · confidence {candidate.confidence.toFixed(2)}
                          </p>
                          <p className="mt-1">"{candidate.supportingExcerpt}"</p>
                          <p className="mt-1 text-ink-600">{candidate.reasoning}</p>
                          {candidate.review ? (
                            <p className={`mt-3 border-l-2 pl-2 ${candidate.review.action === "reject" ? "border-signal-disproven text-signal-disproven" : "border-signal-confirmed text-signal-confirmed"}`}>
                              {candidate.review.action === "approve"
                                ? "Approved"
                                : candidate.review.action === "link_existing_claim"
                                  ? "Resolved to existing claim"
                                  : "Rejected"}
                              {candidate.review.materializedClaimId && <> — claim #{candidate.review.materializedClaimId}</>}
                              {candidate.review.notes && <>: {candidate.review.notes}</>}
                            </p>
                          ) : row.aiResultId !== null ? (
                            (() => {
                              const aiResultId = row.aiResultId as number;
                              const key = `${aiResultId}:${candidate.candidateIndex}`;
                              const duplicateData = duplicateCheckDataByCandidate.get(key);
                              const duplicateState = computeDuplicateCheckDisplayState(hasExistingClaims, duplicateData?.job ?? null, now);
                              const showDuplicateAction = canTriggerDuplicateCheck(duplicateState);
                              const duplicateLabel = showDuplicateAction ? duplicateCheckButtonLabel(duplicateState) : null;
                              const matches = duplicateData?.matches ?? null;

                              return (
                                <>
                                  <div className="mt-3 border border-hairline p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Duplicate check</span>
                                      <span className={`font-mono text-[10px] uppercase tracking-wide ${DUPLICATE_STATUS_CLASS[duplicateState]}`}>
                                        {DUPLICATE_STATUS_LABEL[duplicateState]}
                                      </span>
                                    </div>

                                    {duplicateState === "stale" && (
                                      <p className="mt-2 text-ink-600">
                                        An in-flight attempt started but never reached a terminal outcome within the staleness
                                        window — safe to reclaim and retry.
                                      </p>
                                    )}
                                    {duplicateState === "failed" && duplicateData?.job?.error && (
                                      <p className="mt-2 text-signal-disproven">{duplicateData.job.error}</p>
                                    )}

                                    {matches && matches.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        <p className="text-ink-600">Possible matches — advisory only, review before acting:</p>
                                        {matches.map((match) => (
                                          <div key={match.existingClaimId} className="border-l-2 border-accent-brass/50 pl-2">
                                            <p className="text-ink-100">
                                              Claim #{match.existingClaimId} · confidence {match.confidence.toFixed(2)}
                                            </p>
                                            <p className="mt-1 text-ink-600">{match.reasoning}</p>
                                            <form action={resolveAsExistingClaimAction} className="mt-2 flex flex-wrap items-center gap-2">
                                              <input type="hidden" name="aiResultId" value={aiResultId} />
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
                                    {matches && matches.length === 0 && duplicateState === "succeeded" && (
                                      <p className="mt-2 text-ink-600">No likely duplicate found.</p>
                                    )}

                                    {showDuplicateAction && duplicateLabel && (
                                      <form action={runDetectDuplicatesAction} className="mt-3">
                                        <input type="hidden" name="aiResultId" value={aiResultId} />
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

                                  <details className="mt-3 border border-hairline p-3">
                                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-accent-brass">
                                      Review this candidate
                                    </summary>
                                    <p className="mt-3 text-ink-600">
                                      The quoted source text is fixed provenance. You may edit the proposed claim metadata before approval.
                                    </p>

                                    <form action={approveClaimProposalAction} className="mt-3 space-y-3">
                                      <input type="hidden" name="aiResultId" value={aiResultId} />
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
                                      <input type="hidden" name="aiResultId" value={aiResultId} />
                                      <input type="hidden" name="candidateIndex" value={candidate.candidateIndex} />
                                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Rejection reason</label>
                                      <textarea name="notes" required rows={2} className={reviewInputClass} />
                                      <button type="submit" className={reviewRejectClass}>Reject candidate</button>
                                    </form>
                                  </details>
                                </>
                              );
                            })()
                          ) : null}
                        </div>
                      ))
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

      <h2 className="mt-10 font-display text-xl italic text-ink-100">All AI results</h2>

      {records.length === 0 ? (
        <p className="mt-8 text-sm text-ink-600">No AI recommendation records yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
          {records.map((r) => (
            <li key={`${r.aiResultId}-${r.decisionId ?? "none"}`} className="p-4">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                <span>{r.provider} / {r.model}</span>
                <span>·</span>
                <span>{r.operation}</span>
                <span>·</span>
                <span>confidence {r.confidence ? Number(r.confidence).toFixed(2) : "—"}</span>
              </div>
              <p className="mt-2 text-ink-100">{r.reasoning}</p>
              {r.claimId && <p className="mt-1 font-mono text-xs text-ink-600">claim #{r.claimId}</p>}
              {r.decisionAction && (
                <p
                  className={`mt-2 border-l-2 pl-2 text-xs ${
                    r.decisionAction === "reject" ? "border-signal-disproven text-signal-disproven" : "border-signal-confirmed text-signal-confirmed"
                  }`}
                >
                  {r.decisionAction.toUpperCase()}: {r.decisionNotes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
