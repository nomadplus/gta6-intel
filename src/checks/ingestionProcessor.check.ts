/**
 * Regression check for Phase 4 PR 9 (src/db/mutations/ingestionProcessor.ts):
 * stale-'fetching' reclaim, eligible-job claiming (stuck 'queued' +
 * retryable failures past their nextRetryAt), attempt-count/exhaustion
 * gating, batch size, and -- the actual concurrency-safety property this
 * PR depends on -- that two overlapping claims never both claim the same
 * row (`FOR UPDATE SKIP LOCKED`).
 *
 * This exercises the REAL mutation functions (reclaimStaleFetchingJobs,
 * claimEligibleIngestionJobsForProcessing), not a reimplementation --
 * both are "server-only"-guarded, so this must run with
 * `--conditions=react-server`, same as ingestionAuditLogging.check.ts.
 *
 * Neither function calls requireAdmin() (there is no admin session for
 * an automated processor -- see requireCronSecret.ts for that boundary
 * instead), so this check needs no LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass.
 *
 * Seeds real ingestion_jobs rows directly (bypassing
 * findOrCreateIngestionJob, which isn't the thing under test here) and
 * removes everything it created in a finally block, so this is safe to
 * run repeatedly against the shared local dev database.
 *
 * Run with: npx tsx --conditions=react-server src/checks/ingestionProcessor.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL -- see README.md
 * "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { ingestionJobs } from "../db/schema";
import {
  reclaimStaleFetchingJobs,
  claimEligibleIngestionJobsForProcessing,
} from "../db/mutations/ingestionProcessor";
import { MAX_INGESTION_ATTEMPTS, RECOVERY_STALE_THRESHOLD_MS } from "../lib/ingestion/ingestionJobLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// Seeded reference data (src/db/seed/seed.ts / migration 0007) -- "manual"
// is discovery_providers.id 1. Which provider is used doesn't matter for
// anything under test here.
const MANUAL_PROVIDER_ID = 1;

const NOW = new Date();

function testUrl(label: string): string {
  return `https://example.test/pr9-processor-check-${label}-${randomUUID()}`;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes against ingestion_jobs " +
        "and must never be pointed at a production database."
    );
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdJobIds: number[] = [];

  async function seedJob(overrides: {
    status: (typeof ingestionJobs.$inferInsert)["status"];
    createdAt?: Date;
    startedAt?: Date | null;
    attemptCount?: number;
    nextRetryAt?: Date | null;
  }): Promise<number> {
    const [row] = await db
      .insert(ingestionJobs)
      .values({
        submittedUrl: testUrl(overrides.status ?? "job"),
        normalizedUrl: testUrl(`${overrides.status}-normalized`),
        discoveryProviderId: MANUAL_PROVIDER_ID,
        initiatedBy: "human",
        status: overrides.status,
        createdAt: overrides.createdAt ?? NOW,
        startedAt: overrides.startedAt ?? null,
        attemptCount: overrides.attemptCount ?? 0,
        nextRetryAt: overrides.nextRetryAt ?? null,
      })
      .returning({ id: ingestionJobs.id });
    createdJobIds.push(row!.id);
    return row!.id;
  }

  async function getJob(id: number) {
    const [row] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id));
    return row!;
  }

  try {
    console.log("=== Ingestion processor: reclaim + claim (real functions, --conditions=react-server) ===\n");

    // -------------------------------------------------------------------
    // Stale 'fetching' reclaim
    // -------------------------------------------------------------------
    const staleFetchingId = await seedJob({
      status: "fetching",
      startedAt: new Date(NOW.getTime() - RECOVERY_STALE_THRESHOLD_MS - 60_000), // well past stale threshold
      attemptCount: 1,
    });
    const freshFetchingId = await seedJob({
      status: "fetching",
      startedAt: new Date(NOW.getTime() - 10_000), // 10s ago -- not stale
      attemptCount: 1,
    });
    const exhaustedFetchingId = await seedJob({
      status: "fetching",
      startedAt: new Date(NOW.getTime() - RECOVERY_STALE_THRESHOLD_MS - 60_000),
      attemptCount: MAX_INGESTION_ATTEMPTS,
    });

    const reclaimed = await reclaimStaleFetchingJobs(NOW);
    const reclaimedIds = reclaimed.map((r) => r.jobId);

    assert(reclaimedIds.includes(staleFetchingId), "a job stuck in 'fetching' past the stale threshold is reclaimed");
    assert(!reclaimedIds.includes(freshFetchingId), "a job still within the stale threshold is left alone");
    assert(reclaimedIds.includes(exhaustedFetchingId), "an exhausted stale job is still moved out of 'fetching' (not left stranded)");

    const staleJobAfter = await getJob(staleFetchingId);
    assert(staleJobAfter.status === "fetch_failed", "reclaimed job's status becomes 'fetch_failed'");
    assert(staleJobAfter.nextRetryAt !== null, "reclaimed job with attempts remaining gets a scheduled retry");
    assert(staleJobAfter.failureReason?.includes("Reclaimed") ?? false, "reclaimed job's failure reason is distinguishable from a real fetch error");

    const freshJobAfter = await getJob(freshFetchingId);
    assert(freshJobAfter.status === "fetching", "a job still within the stale threshold is NOT reclaimed (still 'fetching')");

    const exhaustedJobAfter = await getJob(exhaustedFetchingId);
    assert(exhaustedJobAfter.status === "fetch_failed", "exhausted reclaimed job still becomes 'fetch_failed'");
    assert(exhaustedJobAfter.nextRetryAt === null, "exhausted reclaimed job gets no further retry (permanently terminal)");

    // -------------------------------------------------------------------
    // Eligible-job claiming
    // -------------------------------------------------------------------
    const stuckQueuedId = await seedJob({
      status: "queued",
      createdAt: new Date(NOW.getTime() - RECOVERY_STALE_THRESHOLD_MS - 60_000),
      attemptCount: 0,
    });
    const freshQueuedId = await seedJob({
      status: "queued",
      createdAt: new Date(NOW.getTime() - 5_000), // 5s ago -- not stuck
      attemptCount: 0,
    });
    const dueRetryId = await seedJob({
      status: "fetch_failed",
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
      attemptCount: 1,
      nextRetryAt: new Date(NOW.getTime() - 1_000), // due
    });
    const notYetDueRetryId = await seedJob({
      status: "rate_limited",
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
      attemptCount: 1,
      nextRetryAt: new Date(NOW.getTime() + 10 * 60_000), // not due yet
    });
    const exhaustedRetryId = await seedJob({
      status: "fetch_failed",
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
      attemptCount: MAX_INGESTION_ATTEMPTS,
      nextRetryAt: new Date(NOW.getTime() - 1_000), // due, but exhausted
    });
    const nonRetryableTerminalId = await seedJob({
      status: "blocked_by_policy",
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
      attemptCount: 1,
      nextRetryAt: new Date(NOW.getTime() - 1_000), // even if set, status is never eligible
    });

    const claimed = await claimEligibleIngestionJobsForProcessing(NOW, 10);
    const claimedIds = claimed.map((c) => c.id);

    assert(claimedIds.includes(stuckQueuedId), "a stuck 'queued' job is claimed");
    assert(!claimedIds.includes(freshQueuedId), "a freshly-queued job (not stuck) is NOT claimed");
    assert(claimedIds.includes(dueRetryId), "a retryable failure past its nextRetryAt is claimed");
    assert(!claimedIds.includes(notYetDueRetryId), "a retryable failure NOT yet past its nextRetryAt is NOT claimed");
    assert(!claimedIds.includes(exhaustedRetryId), "a retryable failure that has exhausted MAX_INGESTION_ATTEMPTS is NOT claimed");
    assert(!claimedIds.includes(nonRetryableTerminalId), "a non-retryable terminal status is NEVER claimed, regardless of nextRetryAt");

    const stuckQueuedAfter = await getJob(stuckQueuedId);
    assert(stuckQueuedAfter.status === "fetching", "a claimed job is transitioned to 'fetching'");
    assert(stuckQueuedAfter.attemptCount === 1, "a claimed job's attempt_count is incremented as part of the claim");

    const dueRetryAfter = await getJob(dueRetryId);
    assert(dueRetryAfter.attemptCount === 2, "a claimed retry's attempt_count increments from its prior value (1 -> 2)");

    // -------------------------------------------------------------------
    // Batch size + ordering
    // -------------------------------------------------------------------
    const batchIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await seedJob({
        status: "queued",
        createdAt: new Date(NOW.getTime() - RECOVERY_STALE_THRESHOLD_MS - 60_000 - i * 1_000), // each older than the last
        attemptCount: 0,
      });
      batchIds.push(id);
    }
    const batchClaimed = await claimEligibleIngestionJobsForProcessing(NOW, 2);
    assert(batchClaimed.length === 2, `batch size is respected (claimed ${batchClaimed.length}, expected 2)`);
    // Oldest-created-first: the last-seeded id (i=3) has the earliest createdAt.
    const oldestTwoIds = [batchIds[3], batchIds[2]];
    assert(
      batchClaimed.every((c) => oldestTwoIds.includes(c.id)),
      "claiming processes the oldest-created eligible jobs first"
    );

    // Drain the remaining 2 so they don't interfere with the concurrency test below.
    await claimEligibleIngestionJobsForProcessing(NOW, 2);

    // -------------------------------------------------------------------
    // Concurrency: two overlapping claims never claim the same row
    // -------------------------------------------------------------------
    const concurrentIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await seedJob({
        status: "queued",
        createdAt: new Date(NOW.getTime() - RECOVERY_STALE_THRESHOLD_MS - 60_000 - i * 1_000),
        attemptCount: 0,
      });
      concurrentIds.push(id);
    }

    const [resultA, resultB] = await Promise.all([
      claimEligibleIngestionJobsForProcessing(NOW, 6),
      claimEligibleIngestionJobsForProcessing(NOW, 6),
    ]);
    const idsA = new Set(resultA.map((r) => r.id));
    const idsB = new Set(resultB.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));

    assert(overlap.length === 0, "two concurrent claims against the same eligible rows never claim the same job (FOR UPDATE SKIP LOCKED holds)");
    assert(
      idsA.size + idsB.size === concurrentIds.length,
      `every eligible row is claimed exactly once across both concurrent calls (${idsA.size} + ${idsB.size} = ${idsA.size + idsB.size}, expected ${concurrentIds.length})`
    );

    console.log("\nAll ingestion processor checks passed.");
  } finally {
    if (createdJobIds.length > 0) {
      await db.delete(ingestionJobs).where(inArray(ingestionJobs.id, createdJobIds));
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} ingestion processor check(s) FAILED.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
