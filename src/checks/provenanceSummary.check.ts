/**
 * Phase 6 PR-C regression check for the claim provenance summary
 * (src/lib/provenanceSummary.ts). Pure -- no database, no network.
 *
 * Covers, per the locked semantic contract:
 *   1. one isolated source
 *   2. zero reviewed relationships with multiple attached sources
 *   3. simple root -> two dependents
 *   4. multiple dependency types, same normalized direction: one semantic
 *      edge, multiple raw type counts, no conflict
 *   5. opposing dependency directions: two semantic edges, hasCycles true,
 *      NOT a semantic-category conflict
 *   6. `original`'s inverted normalization direction
 *   7. independent pair
 *   8. duplicate raw independent_corroboration directions collapse to one
 *      unordered pair
 *   9. one source participating in multiple independent pairs: pair count
 *      vs distinct source count
 *  10. dependency + independent same unordered pair: conflicted
 *  11. dependency + unknown: conflicted
 *  12. independent + unknown: conflicted
 *  13. conflicted pair excluded from connected components
 *  14. valid unknown pair DOES connect components
 *  15. disconnected two-cluster graph: internalGraphTouchState ===
 *      "all_sources_touched" AND connectedComponentCount === 2
 *  16. isolated sources counted as singleton components
 *  17. cycle members absent from reviewedGraphRootIds
 *  18. deterministic ascending id ordering
 *  19. reviewedInternalPairCount deduplicates unordered pairs
 *  20. possibleInternalPairCount calculation
 *
 * Run with: npx tsx src/checks/provenanceSummary.check.ts
 */
import { computeClaimProvenanceSummary, type ClaimScopedSourceRelationshipRow } from "../lib/provenanceSummary";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function row(a: number, b: number, type: ClaimScopedSourceRelationshipRow["relationshipType"]): ClaimScopedSourceRelationshipRow {
  return { sourceItemIdA: a, sourceItemIdB: b, relationshipType: type };
}

console.log("=== claim provenance summary (Phase 6 PR-C) -- pure, no DB ===\n");

// --- 1. one isolated source ------------------------------------------------
{
  const s = computeClaimProvenanceSummary(1, [10], []);
  assert(s.totalAttachedSources === 1, "1 isolated source: totalAttachedSources === 1");
  assert(s.sourcesWithReviewedInternalRelationship === 0, "1 isolated source: zero sources touched");
  assert(s.sourcesWithoutReviewedInternalRelationship === 1, "1 isolated source: one source untouched");
  assert(s.internalGraphTouchState === "none", "1 isolated source: internalGraphTouchState === 'none'");
  assert(s.connectedComponentCount === 1, "1 isolated source: exactly one (singleton) component");
  assert(s.possibleInternalPairCount === 0, "1 isolated source: C(1,2) === 0 possible pairs");
  assert(s.reviewedGraphRootIds.length === 0, "1 isolated source: no roots (never touched)");
  assert(!s.hasCycles, "1 isolated source: no cycles");
}

// --- 2. zero reviewed relationships, multiple attached sources -----------
{
  const s = computeClaimProvenanceSummary(2, [10, 20, 30], []);
  assert(s.totalAttachedSources === 3, "zero relationships / 3 sources: totalAttachedSources === 3");
  assert(s.sourcesWithReviewedInternalRelationship === 0, "zero relationships / 3 sources: zero touched");
  assert(s.internalGraphTouchState === "none", "zero relationships / 3 sources: internalGraphTouchState === 'none'");
  assert(s.connectedComponentCount === 3, "zero relationships / 3 sources: three singleton components");
  assert(s.possibleInternalPairCount === 3, "zero relationships / 3 sources: C(3,2) === 3 possible pairs");
  assert(s.reviewedInternalPairCount === 0, "zero relationships / 3 sources: zero reviewed pairs");
}

// --- 3. simple root -> two dependents --------------------------------------
{
  // root=1 is the original source for 2 and 3 ("1 -> 2", "1 -> 3" per the
  // `original` mapping: sourceItemIdA=1 IS the origin already).
  const rows = [row(1, 2, "original"), row(1, 3, "original")];
  const s = computeClaimProvenanceSummary(3, [1, 2, 3], rows);
  assert(s.reviewedGraphRootIds.length === 1 && s.reviewedGraphRootIds[0] === 1, "root->2 dependents: source 1 is the sole reviewed-graph root");
  assert(s.dependencySemanticEdgeCount === 2, "root->2 dependents: two distinct semantic edges (1->2, 1->3)");
  assert(s.connectedComponentCount === 1, "root->2 dependents: single connected component");
  assert(!s.hasCycles, "root->2 dependents: no cycle");
  assert(s.internalGraphTouchState === "all_sources_touched", "root->2 dependents: every source touched");
}

// --- 4. multiple dependency types, same normalized direction --------------
{
  // "2 cites 1" (citation: subject=2 depends on object=1 => normalized 1->2)
  // "2 repeats 1" (repetition: same normalization => also 1->2)
  // Same pair, same normalized direction, two different raw types.
  const rows = [row(2, 1, "citation"), row(2, 1, "repetition")];
  const s = computeClaimProvenanceSummary(4, [1, 2], rows);
  assert(s.dependencySemanticEdgeCount === 1, "same-direction multi-type: exactly ONE merged semantic edge");
  assert(s.rawDependencyRelationshipTypeCounts.citation === 1, "same-direction multi-type: raw citation tally === 1");
  assert(s.rawDependencyRelationshipTypeCounts.repetition === 1, "same-direction multi-type: raw repetition tally === 1");
  assert(s.conflictedPairCount === 0, "same-direction multi-type: NOT a conflict");
  assert(s.reviewedGraphRootIds.length === 1 && s.reviewedGraphRootIds[0] === 1, "same-direction multi-type: source 1 is the root");
}

// --- 5. opposing dependency directions -------------------------------------
{
  // "1 cites 2" => normalized 2->1
  // "2 derives from 1" (derivative: subject=2 depends on object=1) => normalized 1->2
  // These are OPPOSING normalized directions for the pair {1,2}.
  const rows = [row(1, 2, "citation"), row(2, 1, "derivative")];
  const s = computeClaimProvenanceSummary(5, [1, 2], rows);
  assert(s.dependencySemanticEdgeCount === 2, "opposing directions: two distinct semantic edges, neither dropped");
  assert(s.hasCycles === true, "opposing directions: forms a 2-node cycle");
  assert(s.conflictedPairCount === 0, "opposing directions: NOT a semantic-category conflict (both rows are 'dependency')");
  assert(s.reviewedGraphRootIds.length === 0, "opposing directions: neither source qualifies as a root (each has an incoming edge)");
  assert(s.connectedComponentCount === 1, "opposing directions: still one connected component");
}

// --- 6. `original`'s inverted normalization direction ----------------------
{
  // (A=5, B=9, original) means "5 is the original source for 9" => normalized 5->9.
  const rows = [row(5, 9, "original")];
  const s = computeClaimProvenanceSummary(6, [5, 9], rows);
  assert(s.reviewedGraphRootIds.length === 1 && s.reviewedGraphRootIds[0] === 5, "original normalization: subject (5) is origin, is the root");
  assert(s.dependencySemanticEdgeCount === 1, "original normalization: exactly one semantic edge");
  assert(s.rawDependencyRelationshipTypeCounts.original === 1, "original normalization: raw 'original' tally === 1");
}

// --- 7. independent pair ---------------------------------------------------
{
  const rows = [row(1, 2, "independent_corroboration")];
  const s = computeClaimProvenanceSummary(7, [1, 2], rows);
  assert(s.independentPairCount === 1, "independent pair: exactly one independent pair");
  assert(s.independentSourceIds.length === 2 && s.independentSourceIds[0] === 1 && s.independentSourceIds[1] === 2, "independent pair: both sources listed, ascending");
  assert(s.dependencySemanticEdgeCount === 0, "independent pair: contributes zero dependency edges");
  assert(s.reviewedGraphRootIds.length === 0, "independent pair: no roots (independence is not dependency)");
}

// --- 8. duplicate raw independent directions collapse ---------------------
{
  const rows = [row(1, 2, "independent_corroboration"), row(2, 1, "independent_corroboration")];
  const s = computeClaimProvenanceSummary(8, [1, 2], rows);
  assert(s.independentPairCount === 1, "duplicate independent directions: collapse to ONE unordered pair, not two");
  assert(s.reviewedInternalPairCount === 1, "duplicate independent directions: one reviewed pair (grouped by unordered pair)");
}

// --- 9. one source in multiple independent pairs ---------------------------
{
  // A(=1) independent with B(=2), C(=3), D(=4).
  const rows = [row(1, 2, "independent_corroboration"), row(1, 3, "independent_corroboration"), row(1, 4, "independent_corroboration")];
  const s = computeClaimProvenanceSummary(9, [1, 2, 3, 4], rows);
  assert(s.independentPairCount === 3, "multi independent pairs: 3 distinct reviewed pairs");
  assert(s.independentSourceIds.length === 4, "multi independent pairs: 4 distinct participating sources (A counted once)");
  assert(
    s.independentSourceIds[0] === 1 && s.independentSourceIds[1] === 2 && s.independentSourceIds[2] === 3 && s.independentSourceIds[3] === 4,
    "multi independent pairs: ascending id order"
  );
}

// --- 10. dependency + independent same pair: conflicted --------------------
{
  const rows = [row(1, 2, "citation"), row(1, 2, "independent_corroboration")];
  const s = computeClaimProvenanceSummary(10, [1, 2], rows);
  assert(s.conflictedPairCount === 1, "dependency+independent: exactly one conflicted pair");
  assert(s.independentPairCount === 0, "dependency+independent: excluded from independentPairCount");
  assert(s.dependencySemanticEdgeCount === 0, "dependency+independent: excluded from dependency graph");
  assert(s.reviewedInternalPairCount === 1, "dependency+independent: still counted once in reviewedInternalPairCount");
  assert(
    s.conflictedPairs.length === 1 &&
      s.conflictedPairs[0]!.sourceItemIdX === 1 &&
      s.conflictedPairs[0]!.sourceItemIdY === 2 &&
      s.conflictedPairs[0]!.categoriesPresent.includes("dependency") &&
      s.conflictedPairs[0]!.categoriesPresent.includes("independent"),
    "dependency+independent: conflictedPairs entry names both categories"
  );
  assert(
    s.rawDependencyRelationshipTypeCounts.citation === 1,
    "dependency+independent: raw dependency-row diagnostic tally still counts the citation row despite the conflict"
  );
}

// --- 11. dependency + unknown: conflicted ----------------------------------
{
  const rows = [row(1, 2, "citation"), row(1, 2, "unknown")];
  const s = computeClaimProvenanceSummary(11, [1, 2], rows);
  assert(s.conflictedPairCount === 1, "dependency+unknown: exactly one conflicted pair");
  assert(s.unknownPairCount === 0, "dependency+unknown: excluded from unknownPairCount");
  assert(s.dependencySemanticEdgeCount === 0, "dependency+unknown: excluded from dependency graph");
}

// --- 12. independent + unknown: conflicted ---------------------------------
{
  const rows = [row(1, 2, "independent_corroboration"), row(1, 2, "unknown")];
  const s = computeClaimProvenanceSummary(12, [1, 2], rows);
  assert(s.conflictedPairCount === 1, "independent+unknown: exactly one conflicted pair");
  assert(s.independentPairCount === 0, "independent+unknown: excluded from independentPairCount");
  assert(s.unknownPairCount === 0, "independent+unknown: excluded from unknownPairCount");
}

// --- 13. conflicted pair excluded from connected components ----------------
{
  const rows = [row(1, 2, "citation"), row(1, 2, "independent_corroboration")];
  const s = computeClaimProvenanceSummary(13, [1, 2], rows);
  assert(s.connectedComponentCount === 2, "conflicted pair: does NOT connect components -- two singleton components remain");
}

// --- 14. valid unknown pair DOES connect components -------------------------
{
  const rows = [row(1, 2, "unknown")];
  const s = computeClaimProvenanceSummary(14, [1, 2], rows);
  assert(s.connectedComponentCount === 1, "valid unknown pair: DOES connect its two sources into one component");
  assert(s.unknownPairCount === 1, "valid unknown pair: counted in unknownPairCount");
}

// --- 15. disconnected two-cluster graph -------------------------------------
{
  // A-B reviewed, C-D reviewed, but A/B never compared against C/D at all.
  const rows = [row(1, 2, "citation"), row(3, 4, "citation")];
  const s = computeClaimProvenanceSummary(15, [1, 2, 3, 4], rows);
  assert(s.internalGraphTouchState === "all_sources_touched", "two-cluster graph: every source has been touched by SOME reviewed relationship");
  assert(s.connectedComponentCount === 2, "two-cluster graph: nonetheless two separate connected components -- 'all_sources_touched' is not exhaustive review");
}

// --- 16. isolated sources counted as singleton components -------------------
{
  const rows = [row(1, 2, "citation")];
  const s = computeClaimProvenanceSummary(16, [1, 2, 99], rows);
  assert(s.connectedComponentCount === 2, "isolated source alongside a reviewed pair: 2 components (the pair, and the isolated source)");
  assert(s.sourcesWithoutReviewedInternalRelationship === 1, "isolated source: exactly one untouched source");
}

// --- 17. cycle members absent from reviewedGraphRootIds ---------------------
{
  // A 3-cycle: 1 cites 2 (=>2->1), 2 cites 3 (=>3->2), 3 cites 1 (=>1->3).
  const rows = [row(1, 2, "citation"), row(2, 3, "citation"), row(3, 1, "citation")];
  const s = computeClaimProvenanceSummary(17, [1, 2, 3], rows);
  assert(s.hasCycles === true, "3-cycle: detected");
  assert(s.reviewedGraphRootIds.length === 0, "3-cycle: no member qualifies as a root (every node has an incoming edge)");
}

// --- 18. deterministic ascending id ordering --------------------------------
{
  const rows = [row(30, 10, "original"), row(30, 20, "original")];
  const s = computeClaimProvenanceSummary(18, [30, 10, 20], rows);
  assert(s.reviewedGraphRootIds[0] === 30, "ascending order: single root (30) present");
  const indepRows = [row(50, 5, "independent_corroboration"), row(50, 25, "independent_corroboration")];
  const s2 = computeClaimProvenanceSummary(18, [50, 5, 25], indepRows);
  assert(
    s2.independentSourceIds[0] === 5 && s2.independentSourceIds[1] === 25 && s2.independentSourceIds[2] === 50,
    "ascending order: independentSourceIds sorted numerically regardless of insertion/attachment order"
  );
}

// --- 19. reviewedInternalPairCount deduplicates unordered pairs ------------
{
  // Same unordered pair, three different rows (two dependency types +
  // querying the reverse direction too) -- must still be ONE reviewed pair.
  const rows = [row(1, 2, "citation"), row(1, 2, "repetition"), row(2, 1, "aggregation")];
  const s = computeClaimProvenanceSummary(19, [1, 2], rows);
  assert(s.reviewedInternalPairCount === 1, "reviewedInternalPairCount: 3 rows on the same unordered pair count as 1 reviewed pair");
}

// --- 20. possibleInternalPairCount calculation ------------------------------
{
  const s = computeClaimProvenanceSummary(20, [1, 2, 3, 4, 5], []);
  assert(s.possibleInternalPairCount === 10, "possibleInternalPairCount: C(5,2) === 10");
}

console.log(failures === 0 ? "\nAll provenance summary checks passed." : `\n${failures} total check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
