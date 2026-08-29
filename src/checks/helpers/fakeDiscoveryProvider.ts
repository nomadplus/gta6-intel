import type { DiscoverySighting, DiscoveryAdmissibility } from "@/lib/discovery/types";

/**
 * Test-only DiscoverySighting factory for Phase 6 PR 6.1's checks.
 * Deliberately lives under src/checks/helpers/, NOT src/lib/discovery/ --
 * same reachability rationale as fakeAiProvider.ts's own file header: it
 * must never be importable from production application code, only from
 * checks. No discovery provider exists yet in this PR (no RSS/social/
 * search integration calls recordDiscoverySighting() in production) --
 * this is a synthetic stand-in for one, with no real HTTP/RSS parsing
 * involved.
 */

/** Seeded by migration 0007's fixed INSERT order -- 'manual' then 'rss'. */
export const MANUAL_PROVIDER_ID = 1;
export const RSS_PROVIDER_ID = 2;

/**
 * Builds a DiscoverySighting with sensible defaults, so each check
 * scenario only needs to specify what it's actually testing.
 */
export function fakeSighting(
  overrides: Partial<DiscoverySighting> & { rawUrl: string }
): DiscoverySighting {
  return {
    discoveryProviderId: MANUAL_PROVIDER_ID,
    admissibility: "held" as DiscoveryAdmissibility,
    ...overrides,
  };
}
