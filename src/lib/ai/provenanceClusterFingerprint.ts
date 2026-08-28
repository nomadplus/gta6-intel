import { createHash } from "crypto";

/**
 * Phase 5 PR 8b. The exact canonical shape of one source item as sent to
 * the model for analyse_provenance, and the ONLY input
 * computeClusterFingerprint accepts -- never claims.statement (see below),
 * never a raw database row.
 *
 * Deliberately excludes claims.statement even though the statement IS sent
 * to the model as context for the call: re-analysis is CLUSTER-change
 * gated, not claim-statement-change gated (a locked PR8b decision). Editing
 * a claim's wording alone must not make a stable, already-analysed cluster
 * look stale.
 *
 * Also deliberately excludes volatile/non-input metadata that has no
 * bearing on what was actually analysed -- retrievedAt (ingestion
 * bookkeeping, never sent to the model) and any future column not part of
 * this exact payload shape.
 */
export interface ClusterItemPayload {
  id: number;
  title: string | null;
  url: string;
  publishedAt: string | null; // ISO 8601, or null if unknown
  excerpt: string | null;
  /**
   * Phase 6 prerequisite: this item's own outbound links whose target
   * resolves to ANOTHER item already inside this same cluster -- never an
   * unresolved link, an out-of-cluster target, or an arbitrary extracted
   * URL (see getInClusterLinksForCluster and analyseProvenanceTrigger.ts).
   * DELIBERATELY OPTIONAL, and omitted entirely (not an empty array) when
   * there is nothing to include -- see computeClusterFingerprint's header
   * for why this is a fingerprint-compatibility requirement, not just a
   * stylistic choice.
   */
  knownOutboundLinks?: {
    toSourceItemId: number;
    anchorText: string | null;
    contextSnippet: string | null;
    placement: "content" | "chrome" | "ambiguous";
    isSameSite: boolean;
  }[];
}

/**
 * Deterministic hash of the EXACT canonical cluster-item payload actually
 * sent to the model, after deterministic truncation (the caller -- the
 * analyse_provenance trigger -- is responsible for building this array in
 * a stable order and applying the 15-item cluster cap before calling this
 * function; this function does not re-sort or re-truncate).
 *
 * A plain SHA-256 of canonical (key-order-independent by construction,
 * since ClusterItemPayload's own field order is fixed by this interface)
 * JSON is sufficient here: this value is never used for anything
 * security-sensitive, only as a cheap "has the input to the last analysis
 * changed" equality check for the re-analysis gate.
 *
 * FINGERPRINT COMPATIBILITY (Phase 6 prerequisite, critical requirement):
 * `knownOutboundLinks` is included in the canonical object ONLY when it is
 * present AND non-empty. When an item has zero known in-cluster links,
 * the canonical object omits the key entirely -- producing byte-identical
 * JSON, and therefore an IDENTICAL fingerprint, to what this function
 * computed before this feature existed. This is what guarantees adding
 * this feature does not make every pre-existing successful
 * analyse_provenance result across all of production look stale merely
 * because the payload shape gained a new (empty) property. Only once an
 * item gains REAL, non-empty in-cluster link evidence does the canonical
 * shape -- and therefore the hash -- actually change, correctly making a
 * previously-`succeeded` analysis eligible for re-analysis under the
 * existing (unmodified) cluster-change-gated re-analysis rule. Each
 * link entry's own field order is fixed and each cluster item's own
 * `knownOutboundLinks` array must already be in a caller-guaranteed
 * deterministic order (analyseProvenanceTrigger.ts sorts by
 * (toSourceItemId asc, then selection order) before calling this
 * function) -- this function does not re-sort that array either.
 */
export function computeClusterFingerprint(items: ClusterItemPayload[]): string {
  const canonical = items.map((item) => {
    const base = {
      id: item.id,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      excerpt: item.excerpt,
    };
    if (item.knownOutboundLinks && item.knownOutboundLinks.length > 0) {
      return { ...base, knownOutboundLinks: item.knownOutboundLinks };
    }
    return base;
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
