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
  getProvenanceClusterForClaim,
  getLatestProvenanceAnalysisJob,
  getLatestSuccessfulProvenanceAnalysisResult,
  listSourceRelationshipReviewsForResult,
  listSourceItemsByIds,
  getAttachedSourceItemIdsForClaim,
  getClaimScopedSourceRelationships,
  getInClusterLinksForCluster,
} from "@/db/queries/admin";
import { computeClaimProvenanceSummary } from "@/lib/provenanceSummary";
import { PROVENANCE_CLUSTER_HARD_CAP } from "@/lib/ai/operations/analyseProvenance";
import { computeClusterFingerprint, type ClusterItemPayload } from "@/lib/ai/provenanceClusterFingerprint";
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
  computeProvenanceAnalysisDisplayState,
  canTriggerProvenanceAnalysis,
  provenanceAnalysisButtonLabel,
  type ProvenanceAnalysisDisplayState,
} from "@/lib/ai/provenanceAnalysisActionability";
import { provenanceSubjectVerb } from "@/lib/provenanceDirection";
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
  runAnalyseProvenanceAction,
  approveSourceRelationshipReviewAction,
  approveSourceRelationshipReviewWithChangesAction,
  rejectSourceRelationshipReviewAction,
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

// Phase 5 PR 8b: six-state provenance-analysis display model (see
// provenanceAnalysisActionability.ts). no_analysable_cluster means the
// claim's linked source-item cluster has 0 or 1 items -- there is nothing
// to relate.
const PROVENANCE_ANALYSIS_STATUS_LABEL: Record<ProvenanceAnalysisDisplayState, string> = {
  no_analysable_cluster: "Fewer than two linked sources -- nothing to analyse yet",
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
    provenanceStatus?: string;
    provenanceError?: string;
    provenanceReviewStatus?: string;
    provenanceReviewError?: string;
  }>;
};

export default async function AdminClaimDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const claimId = Number(id);
  const {
    error,
    saved,
    comparisonStatus,
    comparisonError,
    comparisonReviewStatus,
    comparisonReviewError,
    provenanceStatus,
    provenanceError,
    provenanceReviewStatus,
    provenanceReviewError,
  } = await searchParams;

  const claim = await getClaimForAdmin(claimId);
  if (!claim) notFound();

  const [
    timeline,
    claimSources,
    claimEvidenceRows,
    related,
    topics,
    sourceItems,
    allEvidence,
    allClaims,
    comparableClaimsCount,
    latestCompareClaimsJob,
    provenanceCluster,
    latestProvenanceAnalysisJob,
  ] = await Promise.all([
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
    getProvenanceClusterForClaim(adminDb, claimId, PROVENANCE_CLUSTER_HARD_CAP),
    getLatestProvenanceAnalysisJob(adminDb, claimId),
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

  // Phase 5 PR 8b: the current cluster fingerprint, recomputed fresh on
  // every render from the SAME canonical shape analyseProvenanceTrigger.ts
  // sends to the model -- never cached, never derived from a stale job
  // row. Used both for the no_analysable_cluster gate and for the
  // fingerprint-gated reanalyse action below.
  const currentClusterItems: ClusterItemPayload[] = provenanceCluster.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    excerpt: item.excerpt,
  }));
  const currentClusterFingerprint = currentClusterItems.length > 0 ? computeClusterFingerprint(currentClusterItems) : null;

  // Phase 6 PR-C (SHOULD HAVE): the same resolved in-cluster outbound-link
  // observations analyseProvenanceTrigger.ts already forwards to the model
  // -- surfaced here, per proposed edge, in BOTH directions, so an admin
  // reviewing an edge can see the exact link evidence (if any) the AI saw.
  // Advisory only: presence of a link is not proof of dependency, and its
  // absence is not proof of independence (see the note rendered below).
  const clusterItemIdsForLinkEvidence = provenanceCluster.map((item) => item.id);
  const inClusterLinksForDisplay =
    clusterItemIdsForLinkEvidence.length > 0 ? await getInClusterLinksForCluster(adminDb, clusterItemIdsForLinkEvidence) : [];
  function linkEvidenceForPair(fromSourceItemId: number, toSourceItemId: number) {
    return {
      forward: inClusterLinksForDisplay.filter((l) => l.fromSourceItemId === fromSourceItemId && l.toSourceItemId === toSourceItemId),
      backward: inClusterLinksForDisplay.filter((l) => l.fromSourceItemId === toSourceItemId && l.toSourceItemId === fromSourceItemId),
    };
  }

  const provenanceAnalysisState: ProvenanceAnalysisDisplayState = computeProvenanceAnalysisDisplayState(
    provenanceCluster.length > 1,
    latestProvenanceAnalysisJob,
    new Date()
  );

  const latestProvenanceResult =
    provenanceAnalysisState === "succeeded" ? await getLatestSuccessfulProvenanceAnalysisResult(adminDb, claimId) : null;
  const provenanceReviews = latestProvenanceResult ? await listSourceRelationshipReviewsForResult(adminDb, latestProvenanceResult.aiResultId) : [];
  const provenanceReviewByIndex = new Map(provenanceReviews.map((r) => [r.edgeIndex, r]));
  const provenanceClusterItemIds = latestProvenanceResult ? latestProvenanceResult.edges.flatMap((e) => [e.fromSourceItemId, e.toSourceItemId]) : [];
  const provenanceClusterItems = provenanceClusterItemIds.length > 0 ? await listSourceItemsByIds(adminDb, provenanceClusterItemIds) : [];
  const provenanceItemById = new Map(provenanceClusterItems.map((si) => [si.id, si]));

  // Phase 6 PR-C: the deterministic, claim-scoped provenance summary --
  // entirely derived from human-reviewed durable data (claim_sources +
  // source_relationships, BOTH endpoints attached to this exact claim).
  // No AI call. Deliberately uses the claim's FULL attached source set,
  // not the AI-input-bounded provenanceCluster above (which is capped at
  // PROVENANCE_CLUSTER_HARD_CAP for model input reasons only).
  const attachedSourceItemIdsForSummary = await getAttachedSourceItemIdsForClaim(adminDb, claimId);
  const claimScopedRelationships = await getClaimScopedSourceRelationships(adminDb, attachedSourceItemIdsForSummary);
  const provenanceSummary = computeClaimProvenanceSummary(claimId, attachedSourceItemIdsForSummary, claimScopedRelationships);

  const provenanceSummaryReferencedIds = [
    ...provenanceSummary.reviewedGraphRootIds,
    ...provenanceSummary.independentSourceIds,
    ...provenanceSummary.conflictedPairs.flatMap((p) => [p.sourceItemIdX, p.sourceItemIdY]),
  ];
  const provenanceSummaryItems =
    provenanceSummaryReferencedIds.length > 0 ? await listSourceItemsByIds(adminDb, provenanceSummaryReferencedIds) : [];
  const provenanceSummaryItemById = new Map(provenanceSummaryItems.map((si) => [si.id, si]));
  const provenanceSummaryLabel = (id: number) => provenanceSummaryItemById.get(id)?.title ?? provenanceSummaryItemById.get(id)?.url ?? `#${id}`;

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

      <Section
        title="Provenance intelligence"
        note="Derived entirely from human-reviewed relationships (no AI call). A source appearing in reviewed relationships is not the same as every possible pair having been checked -- see the note on each figure below."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <ProvenanceStat label="Attached sources" value={provenanceSummary.totalAttachedSources} />
          <ProvenanceStat
            label="Sources in a reviewed relationship"
            value={provenanceSummary.sourcesWithReviewedInternalRelationship}
            note="Participation only -- not every pair among these sources has necessarily been compared."
          />
          <ProvenanceStat
            label="Sources with no reviewed relationship"
            value={provenanceSummary.sourcesWithoutReviewedInternalRelationship}
          />
          <ProvenanceStat
            label="Reviewed internal pairs"
            value={provenanceSummary.reviewedInternalPairCount}
            note={`out of ${provenanceSummary.possibleInternalPairCount} possible pairs -- most pairs are expected to stay unreviewed; this is not a completion metric.`}
          />
          <ProvenanceStat label="Dependency connections" value={provenanceSummary.dependencySemanticEdgeCount} />
          <ProvenanceStat label="Independent reviewed pairs" value={provenanceSummary.independentPairCount} />
          <ProvenanceStat label="Sources in an independent pair" value={provenanceSummary.independentSourceIds.length} />
          <ProvenanceStat label="Unknown-classification pairs" value={provenanceSummary.unknownPairCount} />
          <ProvenanceStat label="Connected components" value={provenanceSummary.connectedComponentCount} />
        </dl>

        {provenanceSummary.reviewedGraphRootIds.length > 0 && (
          <p className="mt-4 text-xs text-ink-400">
            <span className="font-mono uppercase tracking-wide text-ink-600">Reviewed-graph roots</span> (source of the
            currently reviewed dependency chain -- not a claim of proven real-world origin):{" "}
            {provenanceSummary.reviewedGraphRootIds.map((id) => provenanceSummaryLabel(id)).join(", ")}
          </p>
        )}

        {provenanceSummary.hasCycles && (
          <p className="mt-3 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
            Cycle warning: the reviewed dependency relationships for this claim contain a cycle (e.g. two sources each
            recorded as depending on the other). Review the underlying relationships below.
          </p>
        )}

        {provenanceSummary.conflictedPairCount > 0 && (
          <div className="mt-3 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
            <p className="font-mono text-xs uppercase tracking-wide">
              {provenanceSummary.conflictedPairCount} conflicted relationship {provenanceSummary.conflictedPairCount === 1 ? "pair" : "pairs"} --
              needs admin attention
            </p>
            <p className="mt-1 text-xs">
              These source-item pairs have reviewed relationships that disagree with each other (e.g. one row says
              dependent, another says independent, or unknown) and are excluded from every count above until resolved.
            </p>
            <ul className="mt-2 space-y-1">
              {provenanceSummary.conflictedPairs.map((p) => (
                <li key={`${p.sourceItemIdX}-${p.sourceItemIdY}`} className="text-xs">
                  {provenanceSummaryLabel(p.sourceItemIdX)} &harr; {provenanceSummaryLabel(p.sourceItemIdY)} — recorded as:{" "}
                  {p.categoriesPresent.join(" + ")}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section
        title="Provenance analysis"
        note="AI-recommended relationships between this claim's linked source items (citation, repetition, derivative, aggregation, independent corroboration) -- advisory only. Nothing here changes the source-item graph until an admin explicitly approves it. Direction reads subject → object (e.g. 'cites', 'derives from')."
      >
        {provenanceError && <p className="mb-3 text-sm text-signal-disproven">{provenanceError}</p>}
        {provenanceStatus && <p className="mb-3 text-sm text-ink-600">Analysis status: {provenanceStatus}</p>}
        {provenanceReviewError && <p className="mb-3 text-sm text-signal-disproven">{provenanceReviewError}</p>}
        {provenanceReviewStatus && <p className="mb-3 text-sm text-ink-600">Review status: {provenanceReviewStatus}</p>}

        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wide text-ink-600">
            {PROVENANCE_ANALYSIS_STATUS_LABEL[provenanceAnalysisState]}
          </span>
          {canTriggerProvenanceAnalysis(provenanceAnalysisState, latestProvenanceResult?.clusterFingerprint ?? null, currentClusterFingerprint) && (
            <form action={runAnalyseProvenanceAction}>
              <input type="hidden" name="claimId" value={claim.id} />
              <button type="submit" className={submitClass}>
                {provenanceAnalysisButtonLabel(provenanceAnalysisState, latestProvenanceResult?.clusterFingerprint ?? null, currentClusterFingerprint)}
              </button>
            </form>
          )}
        </div>

        {provenanceAnalysisState === "succeeded" && latestProvenanceResult && (
          <ul className="space-y-3">
            {latestProvenanceResult.edges.length === 0 && (
              <li className="border border-hairline p-3 text-sm text-ink-600">
                No analysable provenance relationship found in the latest analysis.
              </li>
            )}
            {latestProvenanceResult.edges.map((edge, index) => {
              const fromItem = provenanceItemById.get(edge.fromSourceItemId);
              const toItem = provenanceItemById.get(edge.toSourceItemId);
              const review = provenanceReviewByIndex.get(index);
              return (
                <li key={`${latestProvenanceResult.aiResultId}-${index}`} className="border border-hairline p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs uppercase tracking-wide text-accent-brass">{edge.relationshipType}</span>
                    <span className="font-mono text-[10px] text-ink-600">confidence {edge.confidence.toFixed(2)}</span>
                  </div>
                  <p className="mt-1 text-ink-100">
                    #{edge.fromSourceItemId} ({fromItem?.title ?? fromItem?.url ?? "not found"}) {provenanceSubjectVerb(edge.relationshipType)} #
                    {edge.toSourceItemId} ({toItem?.title ?? toItem?.url ?? "not found"})
                  </p>
                  <p className="mt-1 text-xs text-ink-400">Basis: {edge.basis}</p>
                  <p className="mt-1 text-xs italic text-ink-600">{edge.reasoning}</p>
                  {edge.distinctEvidenceSummary && (
                    <p className="mt-1 text-xs text-ink-400">Distinct evidence: {edge.distinctEvidenceSummary}</p>
                  )}

                  {(() => {
                    const { forward, backward } = linkEvidenceForPair(edge.fromSourceItemId, edge.toSourceItemId);
                    if (forward.length === 0 && backward.length === 0) return null;
                    return (
                      <div className="mt-2 border-t border-hairline pt-2 text-xs text-ink-600">
                        <p className="font-mono uppercase tracking-wide">
                          Known outbound links (mechanical observations -- not proof of dependency; their absence is not
                          proof of independence)
                        </p>
                        {forward.map((l, i) => (
                          <p key={`fwd-${i}`} className="mt-1">
                            #{edge.fromSourceItemId} → #{edge.toSourceItemId}: {l.placement}
                            {l.isSameSite ? ", same-site" : ", cross-site"}
                            {l.anchorText ? `, anchor "${l.anchorText}"` : ""}
                          </p>
                        ))}
                        {backward.map((l, i) => (
                          <p key={`bwd-${i}`} className="mt-1">
                            #{edge.toSourceItemId} → #{edge.fromSourceItemId}: {l.placement}
                            {l.isSameSite ? ", same-site" : ", cross-site"}
                            {l.anchorText ? `, anchor "${l.anchorText}"` : ""}
                          </p>
                        ))}
                      </div>
                    );
                  })()}

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
                      <form action={approveSourceRelationshipReviewAction}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="aiResultId" value={latestProvenanceResult.aiResultId} />
                        <input type="hidden" name="edgeIndex" value={index} />
                        <input type="hidden" name="fromSourceItemId" value={edge.fromSourceItemId} />
                        <input type="hidden" name="toSourceItemId" value={edge.toSourceItemId} />
                        <button type="submit" className={submitClass}>
                          Approve
                        </button>
                      </form>
                      <form action={rejectSourceRelationshipReviewAction}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="aiResultId" value={latestProvenanceResult.aiResultId} />
                        <input type="hidden" name="edgeIndex" value={index} />
                        <button type="submit" className={submitClass}>
                          Reject
                        </button>
                      </form>
                      <details className="w-full">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-ink-600">
                          Approve with changes
                        </summary>
                        <form action={approveSourceRelationshipReviewWithChangesAction} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="claimId" value={claim.id} />
                          <input type="hidden" name="aiResultId" value={latestProvenanceResult.aiResultId} />
                          <input type="hidden" name="edgeIndex" value={index} />
                          <input type="hidden" name="fromSourceItemId" value={edge.fromSourceItemId} />
                          <input type="hidden" name="toSourceItemId" value={edge.toSourceItemId} />
                          <Field label="Relationship type">
                            <select name="relationshipType" defaultValue={edge.relationshipType} className={inputClass}>
                              <option value="citation">Citation</option>
                              <option value="repetition">Repetition</option>
                              <option value="derivative">Derivative</option>
                              <option value="aggregation">Aggregation</option>
                              <option value="independent_corroboration">Independent corroboration</option>
                              <option value="unknown">Unknown</option>
                            </select>
                          </Field>
                          <Field label="Direction">
                            <select name="swapDirection" defaultValue="false" className={inputClass}>
                              <option value="false">#{edge.fromSourceItemId} → #{edge.toSourceItemId} (as proposed)</option>
                              <option value="true">#{edge.toSourceItemId} → #{edge.fromSourceItemId} (swapped)</option>
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

/** Phase 6 PR-C: one compact stat in the read-only provenance-intelligence
 * summary. `note`, when given, is the caveat that keeps the figure from
 * being read as a stronger claim than the reviewed data actually supports
 * (see docs/architecture.md's Provenance Intelligence section). */
function ProvenanceStat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</dt>
      <dd className="text-lg text-ink-100">{value}</dd>
      {note && <p className="mt-0.5 text-xs text-ink-600">{note}</p>}
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
