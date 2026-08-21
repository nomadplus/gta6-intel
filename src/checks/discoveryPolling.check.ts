/**
 * Regression check for Phase 4 PR 10 (src/db/mutations/discoveryPolling.ts,
 * src/lib/ingestion/discoveryPollingLifecycle.ts): due-feed selection,
 * FOR UPDATE SKIP LOCKED claim safety, the last_polled_at/last_poll_status
 * claim write, the discovery pre-check dedupe (any prior job, manual or
 * system), the partial-unique-index race between two concurrent
 * system-discovery inserts for the same normalized URL, and correct
 * column population on created jobs.
 *
 * This exercises the REAL mutation functions (claimDueDiscoveryFeeds,
 * recordFeedPollOutcome, createSystemDiscoveredJob), not a
 * reimplementation -- all are "server-only"-guarded, so this must run
 * with `--conditions=react-server`, same as ingestionProcessor.check.ts.
 *
 * Neither function calls requireAdmin() (there is no admin session for
 * an automated poller -- see requireCronSecret.ts for that boundary
 * instead), so this check needs no LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass.
 *
 * Seeds real discovery_feeds and ingestion_jobs rows directly (bypassing
 * createDiscoveryFeed/findOrCreateIngestionJob, which aren't the things
 * under test here) and removes everything it created in a finally
 * block, so this is safe to run repeatedly against the shared local dev
 * database.
 *
 * Run with: npx tsx --conditions=react-server src/checks/discoveryPolling.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL -- see README.md
 * "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { discoveryFeeds, ingestionJobs, discoveryProviders } from "../db/schema";
import {
  claimDueDiscoveryFeeds,
  recordFeedPollOutcome,
  createSystemDiscoveredJob,
} from "../db/mutations/discoveryPolling";
import { isFeedDue, IN_PROGRESS_POLL_STATUS } from "../lib/ingestion/discoveryPollingLifecycle";

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
// check is about polling/job-creation logic, not source identity.
const SEEDED_SOURCE_ID = 1;

const NOW = new Date();

function testFeedUrl(label: string): string {
  return `https://example.test/discovery-poll-check-feed-${label}-${randomUUID()}`;
}

function testItemUrl(label: string): string {
  return `https://example.test/discovery-poll-check-item-${label}-${randomUUID()}`;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes against discovery_feeds and " +
        "ingestion_jobs and must never be pointed at a production database."
    );
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdFeedIds: number[] = [];
  const createdJobIds: number[] = [];

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

  async function seedManualJob(normalizedUrl: string): Promise<number> {
    const [manualProvider] = await db
      .select({ id: discoveryProviders.id })
      .from(discoveryProviders)
      .where(eq(discoveryProviders.slug, "manual"));
    const [row] = await db
      .insert(ingestionJobs)
      .values({
        submittedUrl: normalizedUrl,
        normalizedUrl,
        discoveryProviderId: manualProvider!.id,
        initiatedBy: "human",
        adminUserId: null,
        status: "queued",
        discoveryFeedId: null,
      })
      .returning({ id: ingestionJobs.id });
    createdJobIds.push(row!.id);
    return row!.id;
  }

  async function jobsForNormalizedUrl(normalizedUrl: string) {
    return db.select().from(ingestionJobs).where(eq(ingestionJobs.normalizedUrl, normalizedUrl));
  }

  try {
    console.log("=== Discovery polling: claim, dedupe, race safety (real functions, --conditions=react-server) ===\n");

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
    await recordFeedPollOutcome(dueId, "ok: 3 items, 1 new, 2 already discovered");
    const feedAfterOutcome = await getFeed(dueId);
    assert(
      feedAfterOutcome.lastPollStatus === "ok: 3 items, 1 new, 2 already discovered",
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
    // Discovery pre-check dedupe: skip if ANY prior job exists (manual or system)
    // -------------------------------------------------------------------
    const feedForDedupeTest = await seedFeed({ lastPolledAt: null });
    const manualUrl = testItemUrl("manual-precheck");
    await seedManualJob(manualUrl);

    const precheckResult = await createSystemDiscoveredJob({
      submittedUrl: manualUrl,
      normalizedUrl: manualUrl,
      discoveryFeedId: feedForDedupeTest,
    });
    assert(
      precheckResult.outcome === "already_discovered",
      `a URL already covered by a prior MANUAL job is skipped by the system pre-check (got "${precheckResult.outcome}")`
    );
    const jobsForManualUrl = await jobsForNormalizedUrl(manualUrl);
    assert(jobsForManualUrl.length === 1, "no second (system) job is created for a URL a manual job already covers");

    // -------------------------------------------------------------------
    // Column correctness on a genuinely new system-discovered job
    // -------------------------------------------------------------------
    const freshUrl = testItemUrl("fresh");
    const createResult = await createSystemDiscoveredJob({
      submittedUrl: freshUrl + "?utm_source=feed", // deliberately different from normalizedUrl, to prove submittedUrl is stored as-given
      normalizedUrl: freshUrl,
      discoveryFeedId: feedForDedupeTest,
    });
    assert(createResult.outcome === "created", `a genuinely new URL creates a job (got "${createResult.outcome}")`);
    if (createResult.outcome === "created") {
      createdJobIds.push(createResult.jobId);
      const [createdRow] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, createResult.jobId));
      assert(createdRow?.discoveryFeedId === feedForDedupeTest, "created job's discovery_feed_id matches the polling feed");
      assert(createdRow?.initiatedBy === "system", `created job's initiated_by is 'system' (got "${createdRow?.initiatedBy}")`);
      assert(createdRow?.adminUserId === null, "created job's admin_user_id is null");
      assert(createdRow?.status === "queued", "created job's status is 'queued'");
      assert(
        createdRow?.submittedUrl === freshUrl + "?utm_source=feed",
        "created job's submitted_url preserves the raw feed-supplied URL, distinct from normalized_url"
      );

      const [rssProvider] = await db.select().from(discoveryProviders).where(eq(discoveryProviders.slug, "rss"));
      assert(createdRow?.discoveryProviderId === rssProvider!.id, "created job's discovery_provider_id is the seeded 'rss' provider");
    }

    // -------------------------------------------------------------------
    // Partial unique index race: two concurrent system inserts for the
    // SAME normalized URL produce exactly one job.
    // -------------------------------------------------------------------
    const raceFeedId = await seedFeed({ lastPolledAt: null });
    const raceUrl = testItemUrl("race");

    const [raceResultA, raceResultB] = await Promise.all([
      createSystemDiscoveredJob({ submittedUrl: raceUrl, normalizedUrl: raceUrl, discoveryFeedId: raceFeedId }),
      createSystemDiscoveredJob({ submittedUrl: raceUrl, normalizedUrl: raceUrl, discoveryFeedId: raceFeedId }),
    ]);

    const outcomes = [raceResultA.outcome, raceResultB.outcome].sort();
    assert(
      outcomes[0] === "already_discovered" && outcomes[1] === "created",
      `two concurrent system-discovery attempts for the same normalized URL yield exactly one 'created' and one 'already_discovered' (got [${outcomes.join(", ")}])`
    );

    if (raceResultA.outcome === "created") createdJobIds.push(raceResultA.jobId);
    if (raceResultB.outcome === "created") createdJobIds.push(raceResultB.jobId);

    const raceRows = await jobsForNormalizedUrl(raceUrl);
    assert(
      raceRows.length === 1,
      `exactly one ingestion_jobs row exists for the raced normalized URL, proving the partial unique index (not just the pre-check) is what prevented a duplicate (got ${raceRows.length} rows)`
    );
  } finally {
    if (createdJobIds.length > 0) {
      await db.delete(ingestionJobs).where(inArray(ingestionJobs.id, createdJobIds));
    }
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
