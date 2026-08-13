/**
 * Pure canonicalization logic, no I/O, no "server-only" dependency --
 * same pattern as authorization.ts, and for the same reason: this is
 * genuine decision logic worth unit-testing directly rather than only
 * through a database round trip.
 */

/**
 * Relationship types where "A equivalent B" and "B equivalent A" are the
 * same underlying fact. Canonicalized to a deterministic ordering (lower
 * claim id always stored as claim_id_a) so a reversed-direction duplicate
 * can never race past a check-then-insert -- the canonical form makes
 * both directions produce the identical row, which the database's unique
 * constraint then catches unconditionally, not probabilistically.
 */
export const SYMMETRIC_RELATIONSHIP_TYPES = new Set(["equivalent", "related", "contradicts"]);

/**
 * Relationship types where direction is the meaningful part of the fact
 * ("A subsumes B" is not the same claim as "B subsumes A"). Never
 * canonicalized -- stored exactly as submitted.
 */
export const DIRECTIONAL_RELATIONSHIP_TYPES = new Set(["subsumes", "refines"]);

export function canonicalizeClaimRelationshipPair(
  claimIdA: number,
  claimIdB: number,
  relationshipType: string
): [number, number] {
  if (SYMMETRIC_RELATIONSHIP_TYPES.has(relationshipType)) {
    return claimIdA < claimIdB ? [claimIdA, claimIdB] : [claimIdB, claimIdA];
  }
  return [claimIdA, claimIdB];
}
