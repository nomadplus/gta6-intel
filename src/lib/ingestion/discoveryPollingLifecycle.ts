/**
 * Pure decision logic for discovery-feed polling, kept separate from
 * the actual database reads/writes (src/db/mutations/discoveryPolling.ts)
 * — same rationale as ingestionJobLifecycle.ts: exercisable with plain
 * objects and an injected clock, no live Postgres needed.
 */

/**
 * Conservative default batch size, chosen against the same 300s Fluid
 * Compute function budget as PR 9's DEFAULT_PROCESSOR_BATCH_SIZE, and
 * for the same reason: safeFetch's worst case is 45s
 * (DEFAULT_TOTAL_TIMEOUT_MS), so 5 feeds × 45s = 225s leaves comfortable
 * headroom under 300s for parsing and database writes. This route has
 * its own dedicated cron/budget (Locked Decision 5) rather than sharing
 * PR 9's, so this constant is independent of
 * DEFAULT_PROCESSOR_BATCH_SIZE even though it happens to match it.
 */
export const DEFAULT_FEED_POLL_BATCH_SIZE = 5;

/** The one recognized in-progress marker value for `discovery_feeds.last_poll_status` (Locked Decision 1) -- written at claim time, overwritten with a descriptive outcome once that feed's poll completes. */
export const IN_PROGRESS_POLL_STATUS = "polling";

export interface FeedDueCandidate {
  enabled: boolean;
  lastPolledAt: Date | null;
  pollingIntervalMinutes: number;
}

/**
 * Whether a feed is currently due to be polled. Mirrors the SQL
 * predicate used by the actual claiming query
 * (src/db/mutations/discoveryPolling.ts) exactly, so this can be
 * exercised as a pure unit test independent of the database, and so the
 * SQL and this function can be checked against each other rather than
 * drifting apart.
 */
export function isFeedDue(feed: FeedDueCandidate, now: Date): boolean {
  if (!feed.enabled) return false;
  if (feed.lastPolledAt === null) return true;
  const dueAt = feed.lastPolledAt.getTime() + feed.pollingIntervalMinutes * 60_000;
  return dueAt <= now.getTime();
}
