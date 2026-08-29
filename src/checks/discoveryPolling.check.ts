/**
 * Regression check for Phase 4 PR 10 / Phase 6 PR 6.2
 * (src/db/mutations/discoveryPolling.ts,
 * src/lib/ingestion/discoveryPollingLifecycle.ts): due-feed selection,
 * FOR UPDATE SKIP LOCKED claim safety, the last_polled_at/last_poll_status
 * claim write, and the RSS provider identity lookup.
 *
 * Phase 6 PR 6.2 retired createSystemDiscoveredJob() -- RSS no longer
 * creates ingestion_jobs directly. This file no longer exercises that
 * function (it doesn't exist anymore); the RSS-through-the-candidate-
 * ledger behavior it used to cover (dedupe, column population on created
 * jobs, the partial-unique-index race) is now covered by
 * discoveryCandidateLedger.check.ts's own recordDiscoverySighting() /
 * claimEligibleCandidatesForPromotion(ByIds)() coverage, since that is
 * where the actual logic now lives. What THIS file adds for PR 6.2 is
 * the recovery-capacity invariant below: a live, non-hardcoded proof
 * that RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE actually covers one
 * complete worst-case poll invocation's own output
 * (DEFAULT_FEED_POLL_BATCH_SIZE x MAX_ITEMS_PER_FEED), so a future
 * change to either upstream constant that isn't also reflected in the
 * recovery quota fails this check loudly rather than silently going
 * stale.
 *
 * This exercises the REAL mutation functions (claimDueDiscoveryFeeds,
 * recordFeedPollOutcome, getRssDiscoveryProviderId), not a
 * reimplementation -- all are "server-only"-guarded, so this must run
 * with `--conditions=react-server`, same as ingestionProcessor.check.ts.
 *
 * Neither function calls requireAdmin() (there is no admin session for
 * an automated poller -- see requireCronSecret.ts for that boundary
 * instead), so this check needs no LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass.
 *
 * Seeds real discovery_feeds rows directly and removes everything it
 * created in a finally block, so this is safe to run repeatedly against
 * the shared local dev database.
 *
 * Run with: npx tsx --conditions=react-server src/checks/discoveryPolling.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL -- see README.md
 * "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { discoveryFeeds, discoveryProviders } from "../db/schema";
import { claimDueDiscoveryFeeds, recordFeedPollOutcome, getRssDiscoveryProviderId } from "../db/mutations/discoveryPolling";
import {
  isFeedDue,
  IN_PROGRESS_POLL_STATUS,
  DEFAULT_FEED_POLL_BATCH_SIZE,
  RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE,
  PartialFeedPollError,
  partialCountsFromUnexpectedFeedError,
} from "../lib/ingestion/discoveryPollingLifecycle";
import { MAX_ITEMS_PER_FEED } from "../lib/ingestion/feedParsing";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// Seeded reference data (src/db/seed/seed.ts) -- the first source row in
// a freshly seeded database. Any valid source id works here since this
// check is about polling logic, not source identity.
const SEEDED_SOURCE_ID = 1;

const NOW = new Date();

function testFeedUrl(label: string): string {
  return `https://example.test/discovery-poll-check-feed-${label}-${randomUUID()}`;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: this check performs real writes against discovery_feeds and must never be pointed at a production database.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdFeedIds: number[] = [];

  async function seedFeed(overrides: {
    enabled?: boolean;
    lastPolledAt?: Date | null;
    pollingIntervalMinutes?: number;
  }): Promise<number> {
    const [row] = await db
      .insert(discoveryFeeds)
      .values({
        sourceId: SEEDED_SOURCE_ID,
        feedUrl: testFeedUrl("seed"),
        enabled: overrides.enabled ?? true,
        pollingIntervalMinutes: overrides.pollingIntervalMinutes ?? 60,
        lastPolledAt: overrides.lastPolledAt ?? null,
      })
      .returning({ id: discoveryFeeds.id });
    createdFeedIds.push(row!.id);
    return row!.id;
  }

  async function getFeed(id: number) {
    const [row] = await db.select().from(discoveryFeeds).where(eq(discoveryFeeds.id, id));
    return row!;
  }

  try {
    console.log("=== Discovery polling: claim, dedupe, race safety, recovery-quota invariant (real functions, --conditions=react-server) ===\n");

    // -------------------------------------------------------------------
    // isFeedDue -- pure logic, no DB
    // -------------------------------------------------------------------
    assert(isFeedDue({ enabled: true, lastPolledAt: null, pollingIntervalMinutes: 60 }, NOW), "a never-polled, enabled feed is due");
    assert(
      !isFeedDue({ enabled: true, lastPolledAt: new Date(NOW.getTime() - 5 * 60_000), pollingIntervalMinutes: 60 }, NOW),
      "a feed polled 5 minutes ago with a 60-minute interval is NOT yet due"
    );
    assert(
      isFeedDue({ enabled: true, lastPolledAt: new Date(NOW.getTime() - 61 * 60_000), pollingIntervalMinutes: 60 }, NOW),
      "a feed polled 61 minutes ago with a 60-minute interval IS due"
    );
    assert(
      !isFeedDue({ enabled: false, lastPolledAt: null, pollingIntervalMinutes: 60 }, NOW),
      "a disabled feed is never due, even if never polled"
    );

    // -------------------------------------------------------------------
    // Phase 6 PR 6.2 correction: partial-feed unexpected-error
    // observability. Pure logic, no DB -- proves
    // partialCountsFromUnexpectedFeedError() recovers truthful partial
    // progress from a PartialFeedPollError (the actual bug this
    // correction fixes: an unexpected exception partway through a feed's
    // item loop used to be reported as flat zeros, even when several
    // items had already been successfully recorded), and still falls
    // back safely to all-zero for any other kind of thrown value.
    // -------------------------------------------------------------------
    const partialFromRealError = partialCountsFromUnexpectedFeedError(
      new PartialFeedPollError(12, 9, 2, new Error("simulated unexpected failure on item 10 of 12"))
    );
    assert(
      partialFromRealError.itemsParsed === 12 && partialFromRealError.sightingsRecorded === 9 && partialFromRealError.malformedUrlsSkipped === 2,
      `partialCountsFromUnexpectedFeedError() recovers the exact counts a PartialFeedPollError carried (got ${JSON.stringify(partialFromRealError)}, expected {itemsParsed: 12, sightingsRecorded: 9, malformedUrlsSkipped: 2})`
    );

    const partialFromOrdinaryError = partialCountsFromUnexpectedFeedError(new Error("some other unrelated exception"));
    assert(
      partialFromOrdinaryError.itemsParsed === 0 &&
        partialFromOrdinaryError.sightingsRecorded === 0 &&
        partialFromOrdinaryError.malformedUrlsSkipped === 0,
      "partialCountsFromUnexpectedFeedError() falls back to all-zero for an ordinary (non-PartialFeedPollError) exception"
    );

    const partialFromNonError = partialCountsFromUnexpectedFeedError("a thrown string, not even an Error instance");
    assert(
      partialFromNonError.itemsParsed === 0 && partialFromNonError.sightingsRecorded === 0 && partialFromNonError.malformedUrlsSkipped === 0,
      "partialCountsFromUnexpectedFeedError() falls back to all-zero for a thrown non-Error value too"
    );

    // The specific edge case this correction targets: ALL items in the
    // feed were already successfully processed (sightingsRecorded +
    // malformedUrlsSkipped together account for every parsed item) when
    // the exception occurred -- e.g. pollOneFeed's final, success-path
    // recordFeedPollOutcome() write itself threw, after every item had
    // already been recorded. The counts must still be reported in full,
    // not falsely zeroed just because the failure happened at the very
    // end rather than partway through.
    const partialFromFullCompletion = partialCountsFromUnexpectedFeedError(
      new PartialFeedPollError(5, 4, 1, new Error("simulated failure writing the final success-path poll outcome"))
    );
    assert(
      partialFromFullCompletion.itemsParsed === 5 &&
        partialFromFullCompletion.sightingsRecorded === 4 &&
        partialFromFullCompletion.malformedUrlsSkipped === 1 &&
        partialFromFullCompletion.sightingsRecorded + partialFromFullCompletion.malformedUrlsSkipped === partialFromFullCompletion.itemsParsed,
      `partialCountsFromUnexpectedFeedError() reports full item-processing progress even when the failure occurs after every item was already handled (got ${JSON.stringify(partialFromFullCompletion)})`
    );

    // -------------------------------------------------------------------
    // Due-feed selection + claim write (last_polled_at, last_poll_status)
    // -------------------------------------------------------------------
    const neverPolledId = await seedFeed({ lastPolledAt: null });
    const notDueId = await seedFeed({ lastPolledAt: new Date(NOW.getTime() - 5 * 60_000), pollingIntervalMinutes: 60 });
    const dueId = await seedFeed({ lastPolledAt: new Date(NOW.getTime() - 61 * 60_000), pollingIntervalMinutes: 60 });
    const disabledButOverdueId = await seedFeed({
      enabled: false,
      lastPolledAt: new Date(NOW.getTime() - 999 * 60_000),
      pollingIntervalMinutes: 60,
    });

    const claimed = await claimDueDiscoveryFeeds(NOW, 10);
    const claimedIds = claimed.map((c) => c.id);

    assert(claimedIds.includes(neverPolledId), "a never-polled, enabled feed is claimed");
    assert(claimedIds.includes(dueId), "a feed past its polling interval is claimed");
    assert(!claimedIds.includes(notDueId), "a feed not yet past its polling interval is NOT claimed");
    assert(!claimedIds.includes(disabledButOverdueId), "a disabled feed is NEVER claimed, even if overdue");

    const dueFeedAfterClaim = await getFeed(dueId);
    assert(
      dueFeedAfterClaim.lastPolledAt !== null && dueFeedAfterClaim.lastPolledAt.getTime() === NOW.getTime(),
      "claiming a feed writes last_polled_at = now() in the same transaction"
    );
    assert(
      dueFeedAfterClaim.lastPollStatus === IN_PROGRESS_POLL_STATUS,
      `claiming a feed writes last_poll_status = '${IN_PROGRESS_POLL_STATUS}' (got "${dueFeedAfterClaim.lastPollStatus}")`
    );

    const notDueFeedUnchanged = await getFeed(notDueId);
    assert(notDueFeedUnchanged.lastPollStatus === null, "an unclaimed feed's last_poll_status is untouched");

    // -------------------------------------------------------------------
    // Ordering: oldest last_polled_at first (nulls first)
    // -------------------------------------------------------------------
    const olderDueId = await seedFeed({ lastPolledAt: new Date(NOW.getTime() - 200 * 60_000), pollingIntervalMinutes: 60 });
    const newerDueId = await seedFeed({ lastPolledAt: new Date(NOW.getTime() - 100 * 60_000), pollingIntervalMinutes: 60 });
    const orderedClaim = await claimDueDiscoveryFeeds(NOW, 1); // batch size 1 -- only the single longest-waiting feed should come back
    assert(
      orderedClaim.length === 1 && orderedClaim[0]!.id === olderDueId,
      `with a batch size smaller than the due backlog, the longest-waiting feed (oldest last_polled_at) is claimed first (got feed ${orderedClaim[0]?.id}, expected ${olderDueId})`
    );
    await claimDueDiscoveryFeeds(NOW, 1); // drain the remaining one so it doesn't interfere below
    void newerDueId;

    // -------------------------------------------------------------------
    // recordFeedPollOutcome -- overwrites last_poll_status, leaves last_polled_at alone
    // -------------------------------------------------------------------
    const polledAtBeforeOutcome = (await getFeed(dueId)).lastPolledAt;
    await recordFeedPollOutcome(dueId, "ok: 3 items parsed, 3 sightings recorded, 0 malformed skipped");
    const feedAfterOutcome = await getFeed(dueId);
    assert(
      feedAfterOutcome.lastPollStatus === "ok: 3 items parsed, 3 sightings recorded, 0 malformed skipped",
      `recordFeedPollOutcome writes the final outcome string (got "${feedAfterOutcome.lastPollStatus}")`
    );
    assert(
      feedAfterOutcome.lastPolledAt?.getTime() === polledAtBeforeOutcome?.getTime(),
      "recordFeedPollOutcome does not touch last_polled_at, only last_poll_status"
    );

    // -------------------------------------------------------------------
    // SKIP LOCKED overlap safety: two concurrent claims never claim the same feed
    // -------------------------------------------------------------------
    const concurrentFeedIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await seedFeed({ lastPolledAt: new Date(NOW.getTime() - (500 + i) * 60_000), pollingIntervalMinutes: 60 });
      concurrentFeedIds.push(id);
    }
    const [claimA, claimB] = await Promise.all([claimDueDiscoveryFeeds(NOW, 6), claimDueDiscoveryFeeds(NOW, 6)]);
    const idsA = new Set(claimA.map((c) => c.id));
    const idsB = new Set(claimB.map((c) => c.id));
    const feedOverlap = [...idsA].filter((id) => idsB.has(id));
    assert(feedOverlap.length === 0, "two concurrent feed claims never claim the same feed row (FOR UPDATE SKIP LOCKED holds)");
    assert(
      idsA.size + idsB.size === concurrentFeedIds.length,
      `every due feed is claimed exactly once across both concurrent calls (${idsA.size} + ${idsB.size}, expected ${concurrentFeedIds.length})`
    );

    // -------------------------------------------------------------------
    // RSS discovery-provider identity (Phase 6 PR 6.2 -- now exported)
    // -------------------------------------------------------------------
    const rssProviderId = await getRssDiscoveryProviderId();
    const [rssProviderRow] = await db.select().from(discoveryProviders).where(eq(discoveryProviders.slug, "rss"));
    assert(
      rssProviderId === rssProviderRow!.id,
      `getRssDiscoveryProviderId() returns the seeded 'rss' discovery_providers row's id (got ${rssProviderId}, expected ${rssProviderRow!.id})`
    );
    const rssProviderIdSecondCall = await getRssDiscoveryProviderId();
    assert(rssProviderIdSecondCall === rssProviderId, "getRssDiscoveryProviderId() returns a stable, cached id across calls");

    // -------------------------------------------------------------------
    // Phase 6 PR 6.2: recovery-capacity invariant.
    //
    // RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE is a LOCKED value (250), not
    // derived at runtime from DEFAULT_FEED_POLL_BATCH_SIZE x
    // MAX_ITEMS_PER_FEED (see discoveryPollingLifecycle.ts's own header
    // for why -- avoiding an import-cycle risk between that module and
    // feedParsing.ts). This check is what actually pins the relationship:
    // it imports both real upstream constants directly and asserts the
    // arithmetic, so a future change to DEFAULT_FEED_POLL_BATCH_SIZE or
    // MAX_ITEMS_PER_FEED that isn't also reflected in the recovery quota
    // fails this check loudly, rather than silently leaving
    // RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE stale.
    // -------------------------------------------------------------------
    const worstCaseCandidatesPerPoll = DEFAULT_FEED_POLL_BATCH_SIZE * MAX_ITEMS_PER_FEED;
    assert(
      worstCaseCandidatesPerPoll === 250,
      `sanity check on this check's own inputs: DEFAULT_FEED_POLL_BATCH_SIZE (${DEFAULT_FEED_POLL_BATCH_SIZE}) x MAX_ITEMS_PER_FEED (${MAX_ITEMS_PER_FEED}) = ${worstCaseCandidatesPerPoll}, expected 250`
    );
    assert(
      RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE >= worstCaseCandidatesPerPoll,
      `RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE (${RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE}) covers one complete worst-case failed poll's own output ` +
        `(DEFAULT_FEED_POLL_BATCH_SIZE x MAX_ITEMS_PER_FEED = ${worstCaseCandidatesPerPoll}) -- this is the exact invariant that would catch a future ` +
        `increase to either upstream constant silently making the recovery quota stale`
    );
  } finally {
    if (createdFeedIds.length > 0) {
      await db.delete(discoveryFeeds).where(inArray(discoveryFeeds.id, createdFeedIds));
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} discovery polling check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll discovery polling checks passed.");
  }
}

main();
