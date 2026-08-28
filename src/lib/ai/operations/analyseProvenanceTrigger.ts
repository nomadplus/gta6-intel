import "server-only";
import { adminDb } from "@/db/adminClient";
import { getClaimForProvenanceAnalysis, getProvenanceClusterForClaim, getInClusterLinksForCluster, type InClusterLinkRow } from "@/db/queries/admin";
import { analyseProvenance, PROVENANCE_CLUSTER_HARD_CAP, type AnalyseProvenanceOutput } from "./analyseProvenance";
import { computeClusterFingerprint, type ClusterItemPayload } from "@/lib/ai/provenanceClusterFingerprint";
import { getAnthropicProvider } from "@/lib/ai/providers/anthropicProvider";
import type { AiProvider } from "@/lib/ai/types";
import type { RunAiOperationResult } from "@/lib/ai/runAiOperation";

/**
 * Phase 5 PR 8b architecture note: this is the ONE place that decides
 * which provider analyse_provenance actually uses in production, loads
 * the anchor claim and its linked source-item cluster, and enforces this
 * operation's own eligibility gate (cluster size 0 or 1 -> deterministic
 * no_analysable_cluster, no AI job/provider call at all). Mirrors
 * compareClaimsTrigger.ts's role exactly, identity narrowed to one
 * claim-anchored source-item cluster instead of one focus-claim
 * comparison shortlist.
 *
 * Unit of analysis: one claim-anchored source-item cluster. Project scope
 * derives from claims.project_id -- the cluster itself is always exactly
 * the set of source items linked to THIS claim via claim_sources
 * (regardless of project), so no separate project-scoping query is
 * needed the way compareClaimsTrigger.ts's shortlist needs one; the
 * claim's own project_id is read and returned only for callers that need
 * it for display, never used to filter the cluster.
 */

// Per (from,to) directed-pair cap on how many link occurrences are ever
// forwarded into analyse_provenance's prompt (Section 29 of the PR spec) --
// keeps the prompt/fingerprint bounded even when one item links another
// many times (e.g. a repeated "sources:" footnote block). Selection
// priority mirrors linkExtraction.ts's own cap exactly: content first,
// then ambiguous, then chrome, with link_position ascending as the stable
// tiebreaker -- never a naive "first 3 by document order", which would
// systematically favor nav/chrome occurrences over genuine body-content
// ones on some pages.
const MAX_LINK_OCCURRENCES_PER_PAIR = 3;

const PLACEMENT_PRIORITY: Record<InClusterLinkRow["placement"], number> = {
  content: 0,
  ambiguous: 1,
  chrome: 2,
};

/**
 * Groups resolved in-cluster link rows by (fromSourceItemId,
 * toSourceItemId), keeps at most MAX_LINK_OCCURRENCES_PER_PAIR per pair
 * using the priority rule above, and reshapes the survivors into
 * ClusterItemPayload's `knownOutboundLinks` entries, attached to each
 * cluster item that actually HAS outbound in-cluster links. Deterministic
 * output ordering (by toSourceItemId, then original selection order) is
 * what makes computeClusterFingerprint's re-analysis gate stable across
 * repeated calls with unchanged underlying evidence.
 */
function buildKnownOutboundLinksByItem(
  rows: InClusterLinkRow[]
): Map<number, NonNullable<ClusterItemPayload["knownOutboundLinks"]>> {
  const byPair = new Map<string, InClusterLinkRow[]>();
  for (const row of rows) {
    const key = `${row.fromSourceItemId}:${row.toSourceItemId}`;
    const bucket = byPair.get(key);
    if (bucket) bucket.push(row);
    else byPair.set(key, [row]);
  }

  const byFromItem = new Map<number, NonNullable<ClusterItemPayload["knownOutboundLinks"]>>();
  for (const [, occurrences] of byPair) {
    const capped = [...occurrences]
      .sort((a, b) => {
        const priorityDiff = PLACEMENT_PRIORITY[a.placement] - PLACEMENT_PRIORITY[b.placement];
        if (priorityDiff !== 0) return priorityDiff;
        return a.linkPosition - b.linkPosition;
      })
      .slice(0, MAX_LINK_OCCURRENCES_PER_PAIR);

    const fromId = capped[0]!.fromSourceItemId;
    const entries = byFromItem.get(fromId) ?? [];
    for (const row of capped) {
      entries.push({
        toSourceItemId: row.toSourceItemId,
        anchorText: row.anchorText,
        contextSnippet: row.contextSnippet,
        placement: row.placement,
        isSameSite: row.isSameSite,
      });
    }
    byFromItem.set(fromId, entries);
  }

  // Deterministic final ordering per item: by target id, then insertion
  // order (which already reflects the priority/link_position order from
  // the per-pair cap above) -- stable regardless of Map iteration order.
  for (const entries of byFromItem.values()) {
    entries.sort((a, b) => a.toSourceItemId - b.toSourceItemId);
  }

  return byFromItem;
}

export class ProvenanceAnchorClaimNotFoundError extends Error {
  constructor(claimId: number) {
    super(`Claim #${claimId} could not be found -- cannot run provenance analysis for a claim that does not exist.`);
    this.name = "ProvenanceAnchorClaimNotFoundError";
  }
}

export type TriggerAnalyseProvenanceResult =
  | { kind: "no_analysable_cluster" }
  | { kind: "ran"; result: RunAiOperationResult<AnalyseProvenanceOutput>; clusterFingerprint: string };

/**
 * Cluster size 0 or 1 has nothing to analyse -- there is no second item to
 * relate the first one to. This is a deterministic pre-condition
 * short-circuit at the trigger level, exactly like compareClaimsTrigger.ts's
 * own no_comparable_claims short-circuit: no ai_jobs row is created, and
 * the caller (the admin action layer) renders this as the distinct
 * no_analysable_cluster state, not as an "analysed, found nothing"
 * success -- an analysis never actually ran.
 */
export async function triggerAnalyseProvenance(
  claimId: number,
  provider: AiProvider = getAnthropicProvider()
): Promise<TriggerAnalyseProvenanceResult> {
  const claim = await getClaimForProvenanceAnalysis(adminDb, claimId);
  if (!claim) throw new ProvenanceAnchorClaimNotFoundError(claimId);

  // Hard cap enforced here, at the exact boundary between "what exists in
  // the database" and "what gets sent to the model" -- getProvenanceClusterForClaim
  // itself applies a deterministic (ordered by source_item id) LIMIT so
  // the SQL, not application-level slicing, is the one place truncation
  // happens.
  const cluster = await getProvenanceClusterForClaim(adminDb, claimId, PROVENANCE_CLUSTER_HARD_CAP);

  if (cluster.length <= 1) {
    return { kind: "no_analysable_cluster" };
  }

  // Phase 6 prerequisite: only RESOLVED links whose from/to are BOTH
  // inside this exact cluster ever reach the model -- never an unresolved
  // link, never a target outside this claim's own cluster, never an
  // arbitrary extracted URL. getInClusterLinksForCluster already enforces
  // this at the query level (Section 11/28 of the PR spec); this trigger
  // does no further URL-based filtering of its own.
  const clusterItemIds = cluster.map((item) => item.id);
  const inClusterLinkRows = await getInClusterLinksForCluster(adminDb, clusterItemIds);
  const knownOutboundLinksByItem = buildKnownOutboundLinksByItem(inClusterLinkRows);

  const clusterItems: ClusterItemPayload[] = cluster.map((item) => {
    const knownOutboundLinks = knownOutboundLinksByItem.get(item.id);
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      excerpt: item.excerpt,
      // Omitted entirely (not an empty array) when this item has no
      // qualifying in-cluster links -- see computeClusterFingerprint's
      // header for why this is a fingerprint-compatibility requirement,
      // not a stylistic choice.
      ...(knownOutboundLinks && knownOutboundLinks.length > 0 ? { knownOutboundLinks } : {}),
    };
  });

  // The SAME clusterItems array (link-enriched or not) is used for BOTH
  // the fingerprint and the actual model call below -- these must never
  // diverge into two separately-constructed payloads.
  const clusterFingerprint = computeClusterFingerprint(clusterItems);

  const result = await analyseProvenance({
    provider,
    claimId: claim.id,
    claimStatement: claim.statement,
    clusterItems,
    clusterFingerprint,
  });

  return { kind: "ran", result, clusterFingerprint };
}
