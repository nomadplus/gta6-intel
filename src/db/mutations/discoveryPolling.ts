import "server-only";
import { and, eq, asc, sql } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { discoveryFeeds, discoveryProviders } from "@/db/schema";
import {
  DEFAULT_FEED_POLL_BATCH_SIZE,
  IN_PROGRESS_POLL_STATUS,
} from "@/lib/ingestion/discoveryPollingLifecycle";

/**
 * Phase 4 PR 10: DB access for the automated RSS/Atom discovery poller
 * (src/app/api/discovery/poll/route.ts). Deliberately its own module,
 * separate from src/db/mutations/ingestion.ts (the manual,
 * admin-request-driven mutation surface) and from
 * src/db/mutations/ingestionProcessor.ts (PR 9's automated job
 * processor) — this file claims discovery_feeds rows, with no preceding
 * requireAdmin() call, same boundary-auditability rationale as
 * ingestionProcessor.ts's own file header.
 *
 * Phase 6 PR 6.2: this file no longer creates ingestion_jobs directly.
 * createSystemDiscoveredJob() (and its unique-violation helpers) is
 * retired — the poll route now calls recordDiscoverySighting() /
 * claimEligibleCandidatesForPromotion(ByIds)() in
 * src/db/mutations/discoveryCandidates.ts instead, bridging RSS through
 * the Phase 6 PR 6.1 candidate ledger. getRssDiscoveryProviderId() below
 * is now exported, since the poll route still needs the RSS provider id
 * to build each DiscoverySighting -- RSS-specific provider knowledge
 * deliberately stays in this file rather than moving into the
 * provider-neutral discoveryCandidates.ts module.
 */

// ---------------------------------------------------------------------------
// Phase A: claim due feeds
// ---------------------------------------------------------------------------

export interface ClaimedDiscoveryFeed {
  id: number;
  sourceId: number;
  feedUrl: string;
  pollingIntervalMinutes: number;
}

/**
 * Atomically claims up to `batchSize` due, enabled feeds using
 * `FOR UPDATE SKIP LOCKED` (same primitive PR 9 uses for ingestion_jobs
 * — if two invocations overlap, a feed row already locked by one is
 * simply skipped by the other rather than both polling it). Within the
 * SAME short transaction, immediately writes `last_polled_at = now()`
 * and `last_poll_status = 'polling'` (Locked Decision 1) as the durable
 * claim marker — a lock alone provides no protection once the
 * transaction holding it commits and releases it, so the write has to
 * land before that happens.
 *
 * Ordered oldest-`last_polled_at`-first (nulls first, i.e. never-polled
 * feeds get priority) so a backlog larger than one batch drains fairly
 * across runs rather than always favoring the same subset.
 *
 * Accepted trade-off (Locked Decision 1): if this invocation crashes
 * partway through processing a claimed batch, the unprocessed feeds in
 * that batch will already show as "just polled" and wait a full
 * interval before being reconsidered due. No last_poll_attempt_at /
 * stale-reclaim machinery is added for this in PR 10 — see the PR 10
 * plan for why this is proportionate at the project's current scale.
 */
export async function claimDueDiscoveryFeeds(
  now: Date = new Date(),
  batchSize: number = DEFAULT_FEED_POLL_BATCH_SIZE
): Promise<ClaimedDiscoveryFeed[]> {
  return adminDb.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: discoveryFeeds.id })
      .from(discoveryFeeds)
      .where(
        and(
          eq(discoveryFeeds.enabled, true),
          sql`(${discoveryFeeds.lastPolledAt} IS NULL OR ${discoveryFeeds.lastPolledAt} + (${discoveryFeeds.pollingIntervalMinutes} || ' minutes')::interval <= ${now})`
        )
      )
      .orderBy(asc(discoveryFeeds.lastPolledAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const claimed: ClaimedDiscoveryFeed[] = [];
    for (const candidate of candidates) {
      const [row] = await tx
        .update(discoveryFeeds)
        .set({ lastPolledAt: now, lastPollStatus: IN_PROGRESS_POLL_STATUS })
        .where(eq(discoveryFeeds.id, candidate.id))
        .returning({
          id: discoveryFeeds.id,
          sourceId: discoveryFeeds.sourceId,
          feedUrl: discoveryFeeds.feedUrl,
          pollingIntervalMinutes: discoveryFeeds.pollingIntervalMinutes,
        });
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

/** Small, separate update once a claimed feed's poll (success or handled failure) has actually finished — does not touch last_polled_at again, only the observability status string. */
export async function recordFeedPollOutcome(feedId: number, statusText: string): Promise<void> {
  await adminDb.update(discoveryFeeds).set({ lastPollStatus: statusText }).where(eq(discoveryFeeds.id, feedId));
}

// ---------------------------------------------------------------------------
// Phase B (Phase 6 PR 6.2): RSS discovery-provider identity
// ---------------------------------------------------------------------------

let cachedRssDiscoveryProviderId: number | null = null;

/**
 * `discovery_providers` is tiny, seeded, effectively-static reference
 * data — same caching rationale as ingestion.ts's
 * getManualDiscoveryProviderId. Exported as of Phase 6 PR 6.2: the poll
 * route needs this id to build each DiscoverySighting passed to
 * recordDiscoverySighting() (src/db/mutations/discoveryCandidates.ts).
 * Kept in this file rather than moved into discoveryCandidates.ts
 * because that module is deliberately provider-neutral — it has no
 * opinion on which provider is calling it, and RSS-specific identity
 * resolution should not live there.
 */
export async function getRssDiscoveryProviderId(): Promise<number> {
  if (cachedRssDiscoveryProviderId !== null) return cachedRssDiscoveryProviderId;
  const [row] = await adminDb
    .select({ id: discoveryProviders.id })
    .from(discoveryProviders)
    .where(eq(discoveryProviders.slug, "rss"))
    .limit(1);
  if (!row) {
    throw new Error("The 'rss' discovery provider is not seeded -- this is a data integrity problem, not a runtime error.");
  }
  cachedRssDiscoveryProviderId = row.id;
  return row.id;
}
