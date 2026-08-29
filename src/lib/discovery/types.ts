/**
 * Phase 6 PR 6.1: shared types for the discovery candidate ledger
 * (discoveryCandidates / discoveryCandidateObservations, migration 0028).
 *
 * Pure types only -- no I/O, no "server-only" dependency, same convention
 * as src/lib/ingestion/urlNormalization.ts's own file header. Consumed by
 * both the pure fold helper (candidateEligibility.ts) and the DB mutation
 * layer (src/db/mutations/discoveryCandidates.ts).
 */

/**
 * Mirrors the discoveryAdmissibilityEnum in src/db/schema.ts exactly.
 * This is an OPERATIONAL fold for the discovery ledger only -- it carries
 * no epistemic meaning and must never be read as a confidence or truth
 * signal. The relative order (excluded < held < eligible) is defined by
 * ADMISSIBILITY_RANK in candidateEligibility.ts, never by the order these
 * three strings happen to appear here or in the database enum
 * declaration.
 */
export type DiscoveryAdmissibility = "excluded" | "held" | "eligible";

/**
 * One operational sighting of a URL by a provider (optionally scoped to a
 * specific feed). This is the input to recordDiscoverySighting() --
 * upstream provider/feed logic is responsible for computing `admissibility`
 * for its own sighting; this PR has no opinion on how that value is
 * derived (no discovery provider exists yet).
 */
export interface DiscoverySighting {
  /** As reported by the provider/feed, pre-normalization -- preserved for audit as observedUrl. */
  rawUrl: string;
  discoveryProviderId: number;
  /** Present only for RSS/Atom feed sightings -- see the replay-identity note in migration 0028. */
  discoveryFeedId?: number;
  admissibility: DiscoveryAdmissibility;
}

/**
 * Result of recordDiscoverySighting(). Deliberately minimal -- per the
 * approved correction, this PR has no production caller that needs to
 * distinguish a genuinely new observation from a feed replay, so no
 * "recorded" vs "replayed" outcome is invented, and this return contract
 * does not expose new-vs-replay in any form. This module does not
 * manufacture that distinction via xmax, system columns, timestamp
 * comparison, or a race-prone pre-SELECT -- timestamp inference in
 * particular is not a safe identity mechanism, so it is deliberately not
 * suggested as a caller-side workaround either. A future caller that
 * genuinely needs this distinction should get an explicit, deliberately
 * designed signal added to this contract, not infer one from timing.
 */
export type RecordSightingResult =
  | { outcome: "invalid_url"; reason: string }
  | {
      outcome: "recorded";
      candidateId: number;
      observationId: number;
    };

/** One row claimed and promoted by claimEligibleCandidatesForPromotion(). */
export interface PromotedCandidate {
  candidateId: number;
  observationId: number;
  ingestionJobId: number;
  normalizedUrl: string;
}
