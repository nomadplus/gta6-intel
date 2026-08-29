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

/**
 * Phase 6 PR 6.2: the bounded quota this poll's route spends, once per
 * invocation, recovering eligible discovery_candidates rows left behind
 * by an EARLIER invocation whose promotion step failed partway (crash,
 * timeout) -- see claimEligibleCandidatesForPromotion()'s own header in
 * discoveryCandidates.ts for how this value is actually used (a single
 * bounded call, never a loop). This is deliberately its own named
 * constant, independent of discoveryCandidates.ts's private
 * DEFAULT_PROMOTION_BATCH_SIZE (which stays unexported -- the candidate
 * IDs observed by one RSS poll invocation are promoted via the id-scoped
 * claimEligibleCandidatesForPromotionByIds() instead, which needs no
 * shared batch-size constant at all; see that function's own header).
 *
 * LOCKED VALUE: 250, chosen to match one complete worst-case poll's
 * maximum candidate output:
 *
 *   DEFAULT_FEED_POLL_BATCH_SIZE (5) x MAX_ITEMS_PER_FEED (50) = 250
 *
 * This provides bounded global recovery capacity of up to 250
 * candidates per successful poll invocation, matching one worst-case
 * poll's maximum candidate output -- it does NOT guarantee that every
 * candidate stranded by one failed poll is always fully cleared by
 * exactly the next invocation. `FOR UPDATE SKIP LOCKED` can temporarily
 * skip a row still locked by concurrent activity, this call's own 250
 * slots are shared across the ENTIRE eligible, claimable backlog (not
 * reserved for any one prior failure), and some candidates may be
 * historically excluded (their normalized URL already exists in
 * `ingestion_jobs`/`source_items`) rather than genuinely promotable at
 * all. What 250 does guarantee is bounded, monotonic forward progress on
 * whatever backlog is currently claimable, every successful invocation.
 *
 * MAX_ITEMS_PER_FEED lives in feedParsing.ts, not re-imported here to
 * avoid an import cycle between that module and this one -- the
 * relationship is instead pinned by
 * src/checks/discoveryPolling.check.ts, which imports both constants
 * directly and asserts this exact arithmetic, so a future change to
 * either upstream constant that isn't also reflected here fails a check
 * loudly rather than silently making this recovery quota stale.
 *
 * A single call at this size, run once per successful poll invocation
 * (never looped -- see the route for why an unbounded loop is
 * unnecessary and undesirable here), makes bounded forward progress on
 * any backlog without competing with the candidate IDs observed by that
 * same invocation, which are always promoted first via the id-scoped
 * path.
 */
export const RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE = 250;

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

/**
 * Phase 6 PR 6.2 correction: thrown by pollOneFeed's per-item loop
 * (src/app/api/discovery/poll/route.ts) INSTEAD OF letting the original
 * unexpected error propagate bare, so runPoller's outer catch can report
 * truthful partial progress rather than falsely reporting zero. Carries
 * whatever itemsParsed/sightingsRecorded/malformedUrlsSkipped counts had
 * already accumulated before the throw.
 *
 * This never implies anything should be rolled back: each
 * recordDiscoverySighting() call is its own committed transaction, and
 * any candidate ids it returned were already added to this invocation's
 * observedCandidateIds Set before the exception -- both are unaffected
 * by this error existing. Its only job is to carry REPORTING counts
 * through to the outer catch.
 */
export class PartialFeedPollError extends Error {
  constructor(
    public readonly itemsParsed: number,
    public readonly sightingsRecorded: number,
    public readonly malformedUrlsSkipped: number,
    public readonly originalError: unknown
  ) {
    super("Partial feed poll failure -- see originalError");
  }
}

/**
 * Extracts truthful partial-progress counts from whatever runPoller's
 * outer catch received for one feed. A PartialFeedPollError yields the
 * exact counts pollOneFeed had accumulated before its per-item loop
 * threw. Anything else (e.g. an exception thrown before parseFeed even
 * returned, which pollOneFeed has no per-item counts to attach) falls
 * back to all-zero -- still truthful, since zero items had definitively
 * been parsed/recorded by that point.
 */
export function partialCountsFromUnexpectedFeedError(err: unknown): {
  itemsParsed: number;
  sightingsRecorded: number;
  malformedUrlsSkipped: number;
} {
  if (err instanceof PartialFeedPollError) {
    return {
      itemsParsed: err.itemsParsed,
      sightingsRecorded: err.sightingsRecorded,
      malformedUrlsSkipped: err.malformedUrlsSkipped,
    };
  }
  return { itemsParsed: 0, sightingsRecorded: 0, malformedUrlsSkipped: 0 };
}
