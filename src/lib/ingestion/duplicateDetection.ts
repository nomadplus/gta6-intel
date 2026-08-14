/**
 * Historical duplicate/candidate classification (Section 8 of the PR
 * spec). Pure decision logic only -- the caller is responsible for
 * running the actual `source_items` query (`WHERE normalized_url = $1
 * OR canonical_url = $2`) and passing the resulting rows in here; this
 * module never touches the database itself, so it can be exercised
 * deterministically without a live Postgres instance.
 *
 * This only runs AFTER a successful fetch and content hash (Section 8:
 * "Historical duplicate handling happens only AFTER fetch and hash
 * computation") -- it is not the in-flight-job redundancy check (that's
 * a separate, unrelated concern in ingestionJobLifecycle.ts).
 */

export interface CandidateSourceItem {
  id: number;
  normalizedUrl: string | null;
  canonicalUrl: string | null;
  rawContentHash: string | null;
}

export type DuplicateMatchField = "normalizedUrl" | "canonicalUrl";

export type DuplicateClassification =
  /** Candidate exists with the same content hash -- link to it, create nothing new. */
  | { kind: "duplicate"; sourceItemId: number; matchedOn: DuplicateMatchField }
  /**
   * Candidate exists via URL but the content hash differs (or the
   * candidate has no hash on record yet). The admin decides later
   * whether this is a legitimate updated/reused URL -- this pipeline
   * never overwrites the historical row and never silently creates a
   * second one.
   */
  | { kind: "needs_review"; reason: "hash_mismatch"; candidateSourceItemId: number; matchedOn: DuplicateMatchField }
  /** No normalized/canonical URL candidate at all -- proceed to source identity resolution. */
  | { kind: "no_candidate" };

/**
 * Determines which URL field(s) a given candidate row actually matched
 * on, given the newly-fetched item's own normalized/canonical URLs.
 * A candidate the caller's query returned should always match at least
 * one field, but this is computed defensively rather than assumed.
 */
function matchedFields(
  candidate: CandidateSourceItem,
  newNormalizedUrl: string,
  newCanonicalUrl: string | null
): DuplicateMatchField[] {
  const fields: DuplicateMatchField[] = [];
  if (candidate.normalizedUrl !== null && candidate.normalizedUrl === newNormalizedUrl) {
    fields.push("normalizedUrl");
  }
  if (candidate.canonicalUrl !== null && newCanonicalUrl !== null && candidate.canonicalUrl === newCanonicalUrl) {
    fields.push("canonicalUrl");
  }
  return fields;
}

/**
 * Classifies a freshly-fetched item against the candidate `source_items`
 * rows matched by normalized/canonical URL. `candidates` should already
 * be limited to that URL-matched set (Section 8) -- never the full table,
 * and never rows matched only by hash (Section 9 forbids treating a
 * hash-only coincidence as a URL match).
 *
 * Deterministic tie-break when multiple candidates match: the lowest
 * `id` (earliest-created) wins, and a `normalizedUrl` match is checked
 * before a `canonicalUrl`-only match for that same candidate, since
 * `normalizedUrl` is this pipeline's primary identity signal.
 */
export function classifyDuplicateCandidate(
  candidates: readonly CandidateSourceItem[],
  newNormalizedUrl: string,
  newCanonicalUrl: string | null,
  newRawContentHash: string
): DuplicateClassification {
  const matched = candidates
    .map((candidate) => ({ candidate, fields: matchedFields(candidate, newNormalizedUrl, newCanonicalUrl) }))
    .filter((entry) => entry.fields.length > 0)
    .sort((a, b) => a.candidate.id - b.candidate.id);

  if (matched.length === 0) {
    return { kind: "no_candidate" };
  }

  const hashMatch = matched.find((entry) => entry.candidate.rawContentHash === newRawContentHash);
  if (hashMatch) {
    return {
      kind: "duplicate",
      sourceItemId: hashMatch.candidate.id,
      matchedOn: hashMatch.fields.includes("normalizedUrl") ? "normalizedUrl" : "canonicalUrl",
    };
  }

  const first = matched[0]!;
  return {
    kind: "needs_review",
    reason: "hash_mismatch",
    candidateSourceItemId: first.candidate.id,
    matchedOn: first.fields.includes("normalizedUrl") ? "normalizedUrl" : "canonicalUrl",
  };
}
