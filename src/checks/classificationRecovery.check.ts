/**
 * Regression check for Phase 5 PR 3's recovery mutation
 * (src/db/mutations/classificationRecovery.ts) -- exercises the REAL
 * reclaimStaleInFlightClassificationJob() against a real local Postgres
 * database. No AI/provider call happens anywhere in this file (that
 * module is DB-only by design -- see its header comment); AI-touching
 * behavior is covered separately by aiClassifyRelevance.check.ts and
 * classificationOrchestration.check.ts.
 *
 * Covers:
 *   - a FRESH pending/running job is not recovery-eligible -- reclaim
 *     returns {outcome: "fresh_in_flight"} and makes NO database change
 *   - a STALE pending/running job IS recovery-eligible -- reclaim
 *     terminalizes it to 'failed', with an explicit
 *     stale_recovery_reclaimed: error AND a non-null completedAt
 *   - the reclaimed row is preserved (not deleted) -- still queryable by
 *     its original id afterward
 *   - after reclaiming, a fresh pending job CAN be created for the same
 *     source item's classify_relevance operation despite the partial
 *     unique index -- because the reclaimed row no longer matches the
 *     index's predicate
 *   - two concurrent recovery attempts (simulated via Promise.all) on a
 *     source item with NO existing in-flight job cannot both create a
 *     new in-flight job -- the partial unique index allows exactly one
 *     of the two pending-job creations through; the loser gets the
 *     already_in_flight outcome, not a crash or a duplicate row
 *   - the COMBINED end-to-end scenario: a stale job is reclaimed to a
 *     terminal 'failed' state, then two replacement attempts race
 *     concurrently. Asserts the full final row-set explicitly -- the
 *     preserved failed stale row PLUS exactly one new in-flight
 *     replacement row, never zero, never two -- rather than just
 *     ok:true/false on each call in isolation
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/classificationRecovery.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { aiJobs, sourceItems } from "../db/schema";
import { reclaimStaleInFlightClassificationJob } from "../db/mutations/classificationRecovery";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS } from "../lib/ai/classificationRecoveryLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const EDITOR_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes and relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass, which must never be exercised against a production database."
    );
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so reclaimStaleInFlightClassificationJob's internal requireAdmin() call can resolve a session. See README.md.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdSourceItemIds: number[] = [];
  const createdJobIds: number[] = [];

  async function createTestSourceItem(): Promise<number> {
    const url = `https://example.test/pr3-recovery-check-${randomUUID()}`;
    const [row] = await db
      .insert(sourceItems)
      .values({
        sourceId: SEEDED_SOURCE_ID,
        itemTypeId: SEEDED_ITEM_TYPE_ID,
        url,
        normalizedUrl: url,
        title: "Test source item for classification recovery",
        excerpt: "An ordinary excerpt.",
      })
      .returning();
    createdSourceItemIds.push(row.id);
    return row.id;
  }

  async function insertInFlightJob(
    sourceItemId: number,
    status: "pending" | "running",
    ageMs: number
  ): Promise<number> {
    const referenceInstant = new Date(Date.now() - ageMs);
    const [row] = await db
      .insert(aiJobs)
      .values({
        operation: "classify_relevance",
        provider: "fake",
        model: "test-model",
        status,
        sourceItemId,
        createdAt: status === "pending" ? referenceInstant : new Date(Date.now() - ageMs - 1000),
        startedAt: status === "running" ? referenceInstant : null,
      })
      .returning();
    createdJobIds.push(row.id);
    return row.id;
  }

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  try {
    console.log("=== classification recovery mutation (Phase 5 PR 3) -- DB only, no AI calls ===\n");

    // --- fresh pending job: NOT recovery-eligible, no DB change -----------
    {
      const sourceItemId = await createTestSourceItem();
      const jobId = await insertInFlightJob(sourceItemId, "pending", 1000); // 1s old, well under the threshold
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH pending job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH pending job is completely untouched by the reclaim attempt");
    }

    // --- fresh running job: NOT recovery-eligible, no DB change -----------
    {
      const sourceItemId = await createTestSourceItem();
      const jobId = await insertInFlightJob(sourceItemId, "running", 1000);
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH running job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH running job is completely untouched by the reclaim attempt");
    }

    // --- stale pending job: reclaimed, terminal timestamp set, row preserved ---
    {
      const sourceItemId = await createTestSourceItem();
      const jobId = await insertInFlightJob(sourceItemId, "pending", CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(outcome.outcome === "reclaimed", "a STALE pending job returns {outcome: 'reclaimed'}");
      if (outcome.outcome === "reclaimed") {
        assert(outcome.reclaimedJobId === jobId, "the reclaimed job id matches the original stale job");
      }

      const after = await loadJob(jobId);
      assert(after.status === "failed", "the reclaimed row's status is 'failed'");
      assert(
        after.error !== null && after.error.startsWith("stale_recovery_reclaimed:"),
        `the reclaimed row's error starts with 'stale_recovery_reclaimed:' (got ${after.error})`
      );
      assert(after.completedAt !== null, "the reclaimed row has a non-null terminal completedAt timestamp");
      assert(after.id === jobId, "the original row is preserved (same id), not deleted");
      assert(after.createdAt !== null, "the original row's createdAt is preserved, unmutated");
    }

    // --- stale running job: reclaimed the same way ------------------------
    {
      const sourceItemId = await createTestSourceItem();
      const jobId = await insertInFlightJob(sourceItemId, "running", CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(outcome.outcome === "reclaimed", "a STALE running job returns {outcome: 'reclaimed'}");

      const after = await loadJob(jobId);
      assert(after.status === "failed", "the reclaimed running row's status is 'failed'");
      assert(after.completedAt !== null, "the reclaimed running row has a non-null terminal completedAt timestamp");
    }

    // --- after reclaim, a fresh pending job CAN be created despite the
    // partial unique index (the old row no longer matches the predicate) ---
    {
      const sourceItemId = await createTestSourceItem();
      await insertInFlightJob(sourceItemId, "pending", CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const reclaimOutcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(reclaimOutcome.outcome === "reclaimed", "setup: the stale job is reclaimed before the replacement attempt");

      const replacement = await createPendingAiJob({
        operation: "classify_relevance",
        provider: "fake",
        model: "test-model",
        sourceItemId,
      });
      assert(replacement.ok === true, "a replacement pending job CAN be created for the same source item after the stale job was reclaimed");
      if (replacement.ok) createdJobIds.push(replacement.id);
    }

    // --- no in-flight job at all: reclaim is a safe no-op -----------------
    {
      const sourceItemId = await createTestSourceItem();
      const outcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(outcome.outcome === "none", "a source item with NO in-flight job returns {outcome: 'none'}");
    }

    // --- concurrent recovery cannot create two in-flight jobs -------------
    {
      const sourceItemId = await createTestSourceItem();
      // No existing job -- both "recovery attempts" proceed straight to a
      // fresh pending-job creation, simulating two admins clicking
      // "recover" on the same source item at nearly the same instant.
      const [first, second] = await Promise.all([
        createPendingAiJob({ operation: "classify_relevance", provider: "fake", model: "test-model", sourceItemId }),
        createPendingAiJob({ operation: "classify_relevance", provider: "fake", model: "test-model", sourceItemId }),
      ]);

      const results = [first, second];
      const succeeded = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);

      assert(succeeded.length === 1, `exactly one of the two concurrent attempts succeeds (got ${succeeded.length})`);
      assert(rejected.length === 1, `exactly one of the two concurrent attempts is rejected (got ${rejected.length})`);
      if (rejected[0] && !rejected[0].ok) {
        assert(
          rejected[0].reason === "already_in_flight",
          `the losing concurrent attempt returns the controlled 'already_in_flight' outcome (got ${(rejected[0] as { reason: string }).reason})`
        );
      }
      for (const r of succeeded) {
        if (r.ok) createdJobIds.push(r.id);
      }

      const rowsForItem = await db.select().from(aiJobs).where(eq(aiJobs.sourceItemId, sourceItemId));
      assert(rowsForItem.length === 1, `exactly one ai_jobs row exists for this source item after the race (found ${rowsForItem.length})`);
    }

    // --- COMBINED scenario: stale reclaim followed by a concurrent
    // replacement race. This is the exact end-to-end sequence a real
    // "click recover on a stale item" moment can produce if two requests
    // land close together: reclaim the stale row to a terminal state,
    // then race two replacement attempts. Asserts the full row-set
    // invariant explicitly, not just "ok:true/false" -- the stale
    // original must remain as permanent history, and exactly one (never
    // zero, never two) new in-flight row must exist afterward. ---------
    {
      const sourceItemId = await createTestSourceItem();
      const staleJobId = await insertInFlightJob(sourceItemId, "pending", CLASSIFICATION_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      // 1. Stale original row exists before recovery.
      const beforeReclaim = await loadJob(staleJobId);
      assert(beforeReclaim.status === "pending", "combined scenario: the stale original row is 'pending' before recovery");
      assert(beforeReclaim.completedAt === null, "combined scenario: the stale original row has no completedAt before recovery");

      // 2 & 3. Reclaim changes that EXACT row to failed, with a non-null completedAt.
      const reclaimOutcome = await reclaimStaleInFlightClassificationJob(sourceItemId);
      assert(reclaimOutcome.outcome === "reclaimed", "combined scenario: the stale job is reclaimed");
      if (reclaimOutcome.outcome === "reclaimed") {
        assert(reclaimOutcome.reclaimedJobId === staleJobId, "combined scenario: the reclaimed job id is the SAME id as the original stale row");
      }
      const afterReclaim = await loadJob(staleJobId);
      assert(afterReclaim.status === "failed", "combined scenario: reclaim changes the exact stale row to 'failed'");
      assert(afterReclaim.completedAt !== null, "combined scenario: the reclaimed row has a non-null completedAt");
      assert(
        afterReclaim.error !== null && afterReclaim.error.startsWith("stale_recovery_reclaimed:"),
        "combined scenario: the reclaimed row's error is prefixed with 'stale_recovery_reclaimed:'"
      );

      // 5 & 6 & 7. Two concurrent replacement attempts race; exactly one
      // succeeds, exactly one returns already_in_flight.
      const [first, second] = await Promise.all([
        createPendingAiJob({ operation: "classify_relevance", provider: "fake", model: "test-model", sourceItemId }),
        createPendingAiJob({ operation: "classify_relevance", provider: "fake", model: "test-model", sourceItemId }),
      ]);
      const raceResults = [first, second];
      const raceSucceeded = raceResults.filter((r) => r.ok);
      const raceRejected = raceResults.filter((r) => !r.ok);
      assert(raceSucceeded.length === 1, `combined scenario: exactly one replacement attempt succeeds (got ${raceSucceeded.length})`);
      assert(raceRejected.length === 1, `combined scenario: exactly one replacement attempt is rejected (got ${raceRejected.length})`);
      if (raceRejected[0] && !raceRejected[0].ok) {
        assert(
          raceRejected[0].reason === "already_in_flight",
          `combined scenario: the losing replacement attempt returns 'already_in_flight' (got ${(raceRejected[0] as { reason: string }).reason})`
        );
      }
      let replacementJobId: number | null = null;
      for (const r of raceSucceeded) {
        if (r.ok) {
          replacementJobId = r.id;
          createdJobIds.push(r.id);
        }
      }
      assert(replacementJobId !== null, "combined scenario: a replacement job id was captured");

      // 4 & 8. The stale row remains afterward; final history contains
      // the preserved failed stale row PLUS exactly one replacement row
      // (two rows total for this source item).
      const finalRows = await db.select().from(aiJobs).where(eq(aiJobs.sourceItemId, sourceItemId));
      assert(finalRows.length === 2, `combined scenario: exactly 2 total ai_jobs rows exist for this source item afterward (found ${finalRows.length})`);
      const preservedStaleRow = finalRows.find((r) => r.id === staleJobId);
      assert(
        preservedStaleRow !== undefined && preservedStaleRow.status === "failed",
        "combined scenario: the preserved stale row is present in the final history, still 'failed'"
      );
      const preservedReplacementRow = finalRows.find((r) => r.id === replacementJobId);
      assert(
        preservedReplacementRow !== undefined && preservedReplacementRow.status === "pending",
        "combined scenario: the replacement row is present in the final history, 'pending'"
      );

      // 9. Exactly one row matches the classify_relevance in-flight
      // unique-index predicate (status IN pending/running).
      const inFlightRows = finalRows.filter((r) => r.status === "pending" || r.status === "running");
      assert(inFlightRows.length === 1, `combined scenario: exactly 1 row matches the in-flight predicate afterward (found ${inFlightRows.length})`);
      assert(inFlightRows[0]?.id === replacementJobId, "combined scenario: the single in-flight row IS the replacement, not the stale original");
    }

    console.log(failures === 0 ? "\nAll classification recovery mutation checks passed." : `\n${failures} check(s) FAILED.`);
  } finally {
    for (const jobId of createdJobIds) {
      await db.delete(aiJobs).where(eq(aiJobs.id, jobId));
    }
    for (const sourceItemId of createdSourceItemIds) {
      await db.delete(sourceItems).where(eq(sourceItems.id, sourceItemId));
    }
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
