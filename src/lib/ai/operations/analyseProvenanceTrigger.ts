import "server-only";
import { adminDb } from "@/db/adminClient";
import { getClaimForProvenanceAnalysis, getProvenanceClusterForClaim } from "@/db/queries/admin";
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

  const clusterItems: ClusterItemPayload[] = cluster.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    excerpt: item.excerpt,
  }));

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
