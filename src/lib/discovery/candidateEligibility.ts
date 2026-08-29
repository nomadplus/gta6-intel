/**
 * Phase 6 PR 6.1: pure TypeScript mirror of the database's admissibility
 * fold (discovery_admissibility_rank() and raise_discovery_candidate_
 * admissibility() in migration 0028).
 *
 * This module exists ONLY for deterministic test parity -- it is NEVER
 * the authority for persisted state. The database trigger is what
 * actually raises a candidate's admissibility on every observation
 * insert; nothing in the application layer calls foldAdmissibility() to
 * compute or write a persisted value. Keeping this mirror in sync with
 * the SQL rank function (both are exercised against the same nine
 * current/incoming combinations, in discoveryCandidateEligibility.check.ts
 * and discoveryCandidateLedger.check.ts respectively) is what would catch
 * the two definitions drifting apart if the enum is ever extended.
 *
 * Pure, no I/O, no "server-only" dependency -- same convention as
 * src/lib/ingestion/urlNormalization.ts.
 */
import type { DiscoveryAdmissibility } from "./types";

/**
 * The single source of truth for fold ORDER on the TypeScript side.
 * Never derive ordering from array/object key position elsewhere --
 * always compare via this map, exactly mirroring why the SQL side uses an
 * explicit CASE rather than PostgreSQL's enum declaration order.
 */
export const ADMISSIBILITY_RANK: Record<DiscoveryAdmissibility, number> = {
  excluded: 0,
  held: 1,
  eligible: 2,
};

/**
 * Returns whichever of `current`/`incoming` has the higher rank -- the
 * same monotonic "never decreases" fold the database trigger performs.
 * Called with a candidate's existing admissibility and a new
 * observation's admissibility, in that order.
 */
export function foldAdmissibility(
  current: DiscoveryAdmissibility,
  incoming: DiscoveryAdmissibility
): DiscoveryAdmissibility {
  return ADMISSIBILITY_RANK[incoming] > ADMISSIBILITY_RANK[current] ? incoming : current;
}
