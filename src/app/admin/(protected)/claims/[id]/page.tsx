import { notFound } from "next/navigation";
import { adminDb } from "@/db/adminClient";
import {
  getClaimForAdmin,
  listTopicsForAdmin,
  listSourceItemsForAdmin,
  listEvidenceForAdmin,
  listClaimsForAdmin,
  countComparableClaimsForClaim,
  getLatestCompareClaimsJob,
  getLatestSuccessfulCompareClaimsResult,
  listComparisonReviewsForResult,
  listClaimsByIds,
} from "@/db/queries/admin";
import { getClaimTimeline, getClaimSources, getClaimEvidence, getRelatedClaims } from "@/db/queries/claimDetail";
import { StatusPair } from "@/components/status/StatusPair";
import { investigationStatusDisplay, developmentOutcomeDisplay, informationTypeLabel } from "@/lib/statusDisplay";
import { relatedClaimLabel } from "@/lib/relationshipDisplay";
import {
  computeRelationshipAnalysisDisplayState,
  canTriggerRelationshipAnalysis,
  relationshipAnalysisButtonLabel,
  type RelationshipAnalysisDisplayState,
} from "@/lib/ai/relationshipAnalysisActionability";
import {
  updateClaimMetadataAction,
  transitionInvestigationStatusAction,
  transitionDevelopmentOutcomeAction,
  linkClaimSourceAction,
  unlinkClaimSourceAction,
  linkEvidenceToClaimAction,
  unlinkEvidenceFromClaimAction,
  createClaimRelationshipAction,
  deleteClaimRelationshipAction,
  runCompareClaimsAction,
  approveClaimComparisonAction,
  approveClaimComparisonWithChangesAction,
  rejectClaimComparisonAction,
} from "../actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass =
  "border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

// Phase 5 PR 7: six-state relationship-analysis display model (see
// relationshipAnalysisActionability.ts). no_comparable_claims is
// distinct from not_analysed -- an analysis has genuinely never run in
// either case, but no_comparable_claims means running one would be
// pointless (and free, since compareClaimsTrigger.ts never creates a job
// in that case), while not_analysed means one is available and would
// cost something.
const RELATIONSHIP_ANALYSIS_STATUS_LABEL: Record<RelationshipAnalysisDisplayState, string> = {
  no_comparable_claims: "No other claims to compare against yet",
  not_analysed: "Not yet analysed",
  in_progress: "Analysis in progress",
  stale: "Stale — recovery available",
  failed: "Analysis failed",
  succeeded: "Analysed",
};

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    comparisonStatus?: string;
    comparisonError?: string;
    comparisonReviewStatus?: string;
    comparisonReviewError?: string;
  }>;
};

export default async function AdminClaimDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const claimId = Number(id);
  const { error, saved, comparisonStatus, comparisonError, comparisonReviewStatus, comparisonReviewError } = await searchParams;

  const claim = await getClaimForAdmin(claimId);
  if (!claim) notFound();

  const [timeline, claimSources, claimEvidenceRows, related, topics, sourceItems, allEvidence, allClaims, comparableClaimsCount, latestCompareClaimsJob] =
    await Promise.all([
      getClaimTimeline(claimId),
      getClaimSources(claimId),
      getClaimEvidence(claimId),
      getRelatedClaims(claimId),
      listTopicsForAdmin(),
      listSourceItemsForAdmin(),
      listEvidenceForAdmin(),
      listClaimsForAdmin(),
      countComparableClaimsForClaim(adminDb, claimId, claim.projectId),
      getLatestCompareClaimsJob(adminDb, claimId),
    ]);

  const relationshipAnalysisState: RelationshipAnalysisDisplayState = computeRelationshipAnalysisDisplayState(
    comparableClaimsCount > 0,
    latestCompareClaimsJob,
    new Date()
  );

  // Only fetched when there IS a succeeded result to show -- avoids a
  // wasted query for the other five display states.
  const latestComparisonResult =
    relationshipAnalysisState === "succeeded" ? await getLatestSuccessfulCompareClaimsResult(adminDb, claimId) : null;
  const comparisonReviews = latestComparisonResult ? await listComparisonReviewsForResult(adminDb, latestComparisonResult.aiResultId) : [];
  const otherClaimsForComparison = latestComparisonResult
    ? await listClaimsByIds(adminDb, latestComparisonResult.assessments.map((a) => a.otherClaimId))
    : [];
  const otherClaimById = new Map(otherClaimsForComparison.map((c) => [c.id, c]));
  const comparisonReviewByIndex = new Map(comparisonReviews.map((r) => [r.assessmentIndex, r]));

  return (
    <div className="max-w-4xl space-y-12">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Claim #{claim.id}</div>
        <h1 className="font-display text-3xl italic text-ink-100">{claim.statement}</h1>
        <div className="mt-3">
          <StatusPair
            investigationStatus={claim.currentInvestigationStatus}
            developmentOutcome={claim.currentDevelopmentOutcome}
          />
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="ok">Saved.</Banner>}

      <Section title="Metadata">
        <form action={updateClaimMetadataAction} className="space-y-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Statement">
            <textarea name="statement" defaultValue={claim.statement} required rows={3} className={inputClass} />
          </Field>
          <Field label="Slug">
            <input name="slug" defaultValue={claim.slug} required className={inputClass} />
          </Field>
          <Field label="Information type">
            <select name="informationType" defaultValue={claim.informationType} className={inputClass}>
              {Object.entries(informationTypeLabel).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="First reported date">
            <input
              type="date"
              name="firstReportedAt"
              defaultValue={claim.firstReportedAt ? new Date(claim.firstReportedAt).toISOString().slice(0, 10) : ""}
              className={inputClass}
            />
          </Field>
          <Field label="Topics">
            <select name="topicIds" multiple defaultValue={[]} className={`${inputClass} h-28`}>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Save Metadata
          </button>
        </form>
      </Section>

      <Section title="Investigation Status" note="Never edited directly — this always creates a new append-only transition.">
        <TimelineList entries={timeline.filter((t) => t.axis === "investigation")} />
        <form action={transitionInvestigationStatusAction} className="mt-4 space-y-3 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="New status">
            <select name="newStatus" required className={inputClass}>
              {Object.entries(investigationStatusDisplay).map(([v, d]) => (
                <option key={v} value={v}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason">
            <textarea name="reason" required rows={2} className={inputClass} />
          </Field>
          <Field label="Confidence (0–1, optional)">
            <input name="confidence" type="number" step="0.01" min="0" max="1" className={inputClass} />
          </Field>
          <button type="submit" className={submitClass}>
            Record Investigation Status Change
          </button>
        </form>
      </Section>

      <Section title="Development Outcome" note="Never edited directly — this always creates a new append-only transition.">
        <TimelineList entries={timeline.filter((t) => t.axis === "development_outcome")} />
        <form action={transitionDevelopmentOutcomeAction} className="mt-4 space-y-3 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="New outcome">
            <select name="newOutcome" required className={inputClass}>
              {Object.entries(developmentOutcomeDisplay).map(([v, d]) => (
                <option key={v} value={v}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason">
            <textarea name="reason" required rows={2} className={inputClass} />
          </Field>
          <Field label="Confidence (0–1, optional)">
            <input name="confidence" type="number" step="0.01" min="0" max="1" className={inputClass} />
          </Field>
          <button type="submit" className={submitClass}>
            Record Development Outcome Change
          </button>
        </form>
      </Section>

      <Section title="Sources">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {claimSources.map((s) => (
            <li key={s.claimSourceId} className="flex items-center justify-between p-2">
              <span>
                {s.title ?? s.url} <span className="font-mono text-xs text-ink-600">({s.stance})</span>
              </span>
              <form action={unlinkClaimSourceAction}>
                <input type="hidden" name="linkId" value={s.claimSourceId} />
                <input type="hidden" name="claimId" value={claim.id} />
                <button className="font-mono text-xs text-ink-600 hover:text-signal-disproven">unlink</button>
              </form>
            </li>
          ))}
          {claimSources.length === 0 && <li className="p-2 text-ink-600">No sources linked yet.</li>}
        </ul>
        <form action={linkClaimSourceAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Source item">
            <select name="sourceItemId" required className={inputClass}>
              {sourceItems.map((si) => (
                <option key={si.id} value={si.id}>
                  {si.title ?? si.url}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stance">
            <select name="stance" className={inputClass}>
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="mentions">Mentions</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Source
          </button>
        </form>
      </Section>

      <Section title="Evidence" note="Many-to-many — the same evidence can support or contradict multiple claims.">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {claimEvidenceRows.map((e) => (
            <li key={e.evidenceId} className="flex items-center justify-between p-2">
              <span>
                {e.description} <span className="font-mono text-xs text-ink-600">({e.stance})</span>
              </span>
            </li>
          ))}
          {claimEvidenceRows.length === 0 && <li className="p-2 text-ink-600">No evidence linked yet.</li>}
        </ul>
        <form action={linkEvidenceToClaimAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Evidence">
            <select name="evidenceId" required className={inputClass}>
              {allEvidence.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  #{ev.id} — {ev.description.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stance">
            <select name="stance" className={inputClass}>
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="mentions">Mentions</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Evidence
          </button>
        </form>
      </Section>

      <Section
        title="Relationship analysis"
        note="AI-recommended relationships to other existing claims -- advisory only. Nothing here changes the claim graph until an admin explicitly approves it."
      >
        {comparisonError && <p className="mb-3 text-sm text-signal-disproven">{comparisonError}</p>}
        {comparisonStatus && <p className="mb-3 text-sm text-ink-600">Analysis status: {comparisonStatus}</p>}
        {comparisonReviewError && <p className="mb-3 text-sm text-signal-disproven">{comparisonReviewError}</p>}
        {comparisonReviewStatus && <p className="mb-3 text-sm text-ink-600">Review status: {comparisonReviewStatus}</p>}

        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wide text-ink-600">
            {RELATIONSHIP_ANALYSIS_STATUS_LABEL[relationshipAnalysisState]}
          </span>
          {canTriggerRelationshipAnalysis(relationshipAnalysisState) && (
            <form action={runCompareClaimsAction}>
              <input type="hidden" name="claimId" value={claim.id} />
              <button type="submit" className={submitClass}>
                {relationshipAnalysisButtonLabel(relationshipAnalysisState)}
              </button>
            </form>
          )}
        </div>

        {relationshipAnalysisState === "succeeded" && latestComparisonResult && (
          <ul className="space-y-3">
            {latestComparisonResult.assessments.length === 0 && (
              <li className="border border-hairline p-3 text-sm text-ink-600">
                No meaningful relationship found in the latest analysis.
              </li>
            )}
            {latestComparisonResult.assessments.map((assessment, index) => {
              const otherClaim = otherClaimById.get(assessment.otherClaimId);
              const review = comparisonReviewByIndex.get(index);
              return (
                <li key={`${latestComparisonResult.aiResultId}-${index}`} className="border border-hairline p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs uppercase tracking-wide text-accent-brass">
                      {relatedClaimLabel(assessment.relationshipType, assessment.direction !== "other_to_focus")}
                    </span>
                    <span className="font-mono text-[10px] text-ink-600">confidence {assessment.confidence.toFixed(2)}</span>
                  </div>
                  <p className="mt-1 text-ink-100">#{assessment.otherClaimId} — {otherClaim?.statement ?? "(claim not found)"}</p>
                  <p className="mt-1 text-xs italic text-ink-600">{assessment.reasoning}</p>

                  {review ? (
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                      {review.action === "reject"
                        ? "Rejected"
                        : review.relationshipWasNewlyCreated
                          ? `${review.action === "edit" ? "Approved with changes" : "Approved"} — relationship #${review.materializedRelationshipId} created`
                          : `${review.action === "edit" ? "Approved with changes" : "Approved"} — relationship #${review.materializedRelationshipId} already existed`}
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <form action={approveClaimComparisonAction}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="aiResultId" value={latestComparisonResult.aiResultId} />
                        <input type="hidden" name="assessmentIndex" value={index} />
                        <input type="hidden" name="otherClaimId" value={assessment.otherClaimId} />
                        <button type="submit" className={submitClass}>
                          Approve
                        </button>
                      </form>
                      <form action={rejectClaimComparisonAction}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="aiResultId" value={latestComparisonResult.aiResultId} />
                        <input type="hidden" name="assessmentIndex" value={index} />
                        <button type="submit" className={submitClass}>
                          Reject
                        </button>
                      </form>
                      <details className="w-full">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-ink-600">
                          Approve with changes
                        </summary>
                        <form action={approveClaimComparisonWithChangesAction} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="claimId" value={claim.id} />
                          <input type="hidden" name="aiResultId" value={latestComparisonResult.aiResultId} />
                          <input type="hidden" name="assessmentIndex" value={index} />
                          <input type="hidden" name="otherClaimId" value={assessment.otherClaimId} />
                          <Field label="Relationship type">
                            <select name="relationshipType" defaultValue={assessment.relationshipType} className={inputClass}>
                              <option value="equivalent">Equivalent</option>
                              <option value="related">Related</option>
                              <option value="contradicts">Contradicts</option>
                              <option value="subsumes">Subsumes (this claim subsumes the other)</option>
                              <option value="refines">Refines (this claim refines the other)</option>
                            </select>
                          </Field>
                          <Field label="Direction (subsumes/refines only)">
                            <select name="direction" defaultValue={assessment.direction ?? ""} className={inputClass}>
                              <option value="">N/A (symmetric type)</option>
                              <option value="focus_to_other">This claim → other claim</option>
                              <option value="other_to_focus">Other claim → this claim</option>
                            </select>
                          </Field>
                          <button type="submit" className={submitClass}>
                            Save
                          </button>
                        </form>
                      </details>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Related Claims" note="Equivalent, related, and contradicts are canonicalized automatically — direction doesn't matter for those. Subsumes and refines stay directional.">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {related.map((r) => (
            <li key={`${r.id}-${r.relationshipType}`} className="flex items-center justify-between p-2">
              <span>
                <span className="font-mono text-xs uppercase text-accent-brass">{relatedClaimLabel(r.relationshipType, r.viewedClaimIsA)}</span> {r.statement}
              </span>
            </li>
          ))}
          {related.length === 0 && <li className="p-2 text-ink-600">No related claims yet.</li>}
        </ul>
        <form action={createClaimRelationshipAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimIdA" value={claim.id} />
          <Field label="Related claim">
            <select name="claimIdB" required className={inputClass}>
              {allClaims
                .filter((c) => c.id !== claim.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} — {c.statement.slice(0, 60)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Relationship type">
            <select name="relationshipType" className={inputClass}>
              <option value="equivalent">Equivalent</option>
              <option value="related">Related</option>
              <option value="contradicts">Contradicts</option>
              <option value="subsumes">Subsumes (this claim subsumes the other)</option>
              <option value="refines">Refines (this claim refines the other)</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Claim
          </button>
        </form>
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-mono text-xs uppercase tracking-wide text-accent-brass">{title}</h2>
      {note && <p className="mt-1 text-xs text-ink-600">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[180px] flex-1">
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</label>
      {children}
    </div>
  );
}

function Banner({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <p
      className={`border px-3 py-2 text-sm ${
        tone === "error" ? "border-signal-disproven/50 text-signal-disproven" : "border-signal-confirmed/50 text-signal-confirmed"
      }`}
    >
      {children}
    </p>
  );
}

function TimelineList({ entries }: { entries: Awaited<ReturnType<typeof getClaimTimeline>> }) {
  if (entries.length === 0) return <p className="text-sm text-ink-600">No transitions recorded yet.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {entries.map((e) => (
        <li key={e.transitionId} className="border-b border-hairline pb-2">
          <span className="font-mono text-xs text-ink-600">{new Date(e.changedAt).toLocaleDateString()}</span>{" "}
          {e.previousValue ? `${e.previousValue} → ${e.newValue}` : e.newValue}
          <p className="text-xs text-ink-400">{e.reason}</p>
        </li>
      ))}
    </ul>
  );
}
