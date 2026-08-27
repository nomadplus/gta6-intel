/**
 * Phase 5 PR 7. Pure display logic, no I/O, no "server-only" dependency
 * -- same pattern as relationshipCanonicalization.ts and statusDisplay.ts.
 *
 * FIXES A PRE-EXISTING DEFECT (predates PR7): getRelatedClaims
 * (src/db/queries/claimDetail.ts) matches a claim_relationships row for
 * the viewed claim regardless of which side of the stored (claim_id_a,
 * claim_id_b) pair it occupies, but until this PR neither consumer (the
 * admin claim page nor the public RelatedClaims component) accounted for
 * that side at all. For the three SYMMETRIC types (equivalent, related,
 * contradicts) this was harmless -- canonicalization makes the stored
 * orientation an artefact of id ordering, carrying no meaning. For the
 * two DIRECTIONAL types (subsumes, refines), it meant a relationship
 * displayed with its meaning inverted whenever the viewed claim happened
 * to be stored as claim_id_b -- roughly half of all directional rows.
 * The two consumers also disagreed with each other: the public
 * component rendered "refines" in the passive voice ALWAYS ("Refined
 * by"), while the admin page rendered the raw enum value ALWAYS
 * ("REFINES"), regardless of orientation.
 *
 * This is now the ONE implementation of relationship labelling in the
 * codebase -- both consumers call this function and neither maintains
 * its own label map, so they cannot drift apart again.
 */

const SYMMETRIC_LABELS: Record<string, string> = {
  equivalent: "Equivalent to",
  related: "Related to",
  contradicts: "Contradicts",
};

/**
 * A relationship label for the VIEWED claim's perspective.
 *
 * - Symmetric types (equivalent/related/contradicts) ignore
 *   viewedClaimIsA entirely -- correct, since canonicalization makes the
 *   stored orientation meaningless for these three.
 * - subsumes / refines are direction-sensitive: when the viewed claim is
 *   claim_id_a, it is the one doing the subsuming/refining; when it is
 *   claim_id_b, it is the one BEING subsumed/refined by the other claim
 *   shown in the row.
 * - An unrecognized relationshipType falls back to the raw value,
 *   preserving the previous defensive behavior for a value outside the
 *   known enum (relationshipType is typed `string`, not the enum union,
 *   at the query layer).
 */
export function relatedClaimLabel(relationshipType: string, viewedClaimIsA: boolean): string {
  const symmetric = SYMMETRIC_LABELS[relationshipType];
  if (symmetric) return symmetric;

  if (relationshipType === "subsumes") return viewedClaimIsA ? "Subsumes" : "Subsumed by";
  if (relationshipType === "refines") return viewedClaimIsA ? "Refines" : "Refined by";

  return relationshipType;
}
