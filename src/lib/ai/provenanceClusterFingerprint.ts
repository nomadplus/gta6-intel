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
 */
export function computeClusterFingerprint(items: ClusterItemPayload[]): string {
  const canonical = items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    excerpt: item.excerpt,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
