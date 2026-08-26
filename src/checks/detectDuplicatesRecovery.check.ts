/**
 * Regression check for Phase 5 PR 6's recovery mutation
 * (src/db/mutations/detectDuplicatesRecovery.ts) -- exercises the REAL
 * reclaimStaleInFlightDetectDuplicatesJob() against a real local Postgres
 * database. No AI/provider call happens anywhere in this file (that
 * module is DB-only by design). Structurally an exact mirror of
 * extractClaimsRecovery.check.ts, identity narrowed from one
 * sourceItemId to one (extractionAiResultId, extractionCandidateIndex)
 * pair (migration 0018), proving the same race-safe lock/recheck
 * pattern (plain FOR UPDATE, not SKIP LOCKED).
 *
 * Covers:
 *   - a FRESH pending/running job is not recovery-eligible -- reclaim
 *     returns {outcome: "fresh_in_flight"} and makes NO database change
 *   - a STALE pending/running job IS recovery-eligible -- reclaim
 *     terminalizes it to 'failed', with an explicit
 *     stale_recovery_reclaimed: error AND a non-null completedAt
 *   - the reclaimed row is preserved (not deleted)
 *   - after reclaiming, a fresh pending job CAN be created for the same
 *     candidate despite the partial unique index (migration 0018)
 *   - two concurrent recovery attempts on a candidate with NO existing
 *     in-flight job cannot both create a new in-flight job
 *   - the COMBINED end-to-end scenario, mirroring extractClaimsRecovery's
 *   - a REVIEWED candidate (approved) makes recovery refuse with
 *     ProposalAlreadyReviewedForDuplicateCheckError, even when a stale
 *     in-flight job genuinely exists for it -- the eligibility gate is
 *     checked BEFORE the lock is acquired, so the stale row is left
 *     completely untouched
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/detectDuplicatesRecovery.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { aiJobs, aiResults, sourceItems } from "../db/schema";
import { reclaimStaleInFlightDetectDuplicatesJob } from "../db/mutations/detectDuplicatesRecovery";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS } from "../lib/ai/detectDuplicatesRecoveryLifecycle";
import { ProposalAlreadyReviewedForDuplicateCheckError } from "../lib/ai/operations/detectDuplicatesTrigger";
import { approveClaimProposal } from "../db/mutations/claimProposalReviews";

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
const SEEDED_PROJECT_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes and relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass, which must never be exercised against a production database."
    );
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so reclaimStaleInFlightDetectDuplicatesJob's internal requireAdmin() call can resolve a session. See README.md.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  /** One genuine parent ai_results row (mimicking a succeeded extract_claims candidate) -- required by extraction_ai_result_id's real FK. */
  async function createParentAiResult(statement: string): Promise<{ aiResultId: number; sourceItemId: number }> {
    const url = `https://example.test/pr6-recovery-check-${randomUUID()}`;
    const [sourceItem] = await db
      .insert(sourceItems)
      .values({ sourceId: SEEDED_SOURCE_ID, itemTypeId: SEEDED_ITEM_TYPE_ID, url, normalizedUrl: url, title: "Test source item for duplicate-check recovery", excerpt: statement })
      .returning();
    const [job] = await db
      .insert(aiJobs)
      .values({ operation: "extract_claims", provider: "fake", model: "test-model", status: "succeeded", sourceItemId: sourceItem.id, completedAt: new Date() })
      .returning();
    const [result] = await db
      .insert(aiResults)
      .values({ aiJobId: job.id, structuredOutput: { claims: [{ statement, informationType: "report", supportingExcerpt: statement, confidence: 0.9, reasoning: "fixture" }] } })
      .returning();
    return { aiResultId: result.id, sourceItemId: sourceItem.id };
  }

  async function insertInFlightDetectDuplicatesJob(extractionAiResultId: number, extractionCandidateIndex: number, status: "pending" | "running", ageMs: number): Promise<number> {
    const referenceInstant = new Date(Date.now() - ageMs);
    const [row] = await db
      .insert(aiJobs)
      .values({
        operation: "detect_duplicates",
        provider: "fake",
        model: "test-model",
        status,
        extractionAiResultId,
        extractionCandidateIndex,
        createdAt: status === "pending" ? referenceInstant : new Date(Date.now() - ageMs - 1000),
        startedAt: status === "running" ? referenceInstant : null,
      })
      .returning();
    return row.id;
  }

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  try {
    console.log("=== detect_duplicates recovery mutation (Phase 5 PR 6) -- DB only, no AI calls ===\n");

    // --- fresh pending job: NOT recovery-eligible, no DB change -----------
    {
      const { aiResultId } = await createParentAiResult("Fresh pending fixture statement.");
      const jobId = await insertInFlightDetectDuplicatesJob(aiResultId, 0, "pending", 1000);
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH pending job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH pending job is completely untouched by the reclaim attempt");
    }

    // --- fresh running job: NOT recovery-eligible, no DB change -----------
    {
      const { aiResultId } = await createParentAiResult("Fresh running fixture statement.");
      const jobId = await insertInFlightDetectDuplicatesJob(aiResultId, 0, "running", 1000);
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH running job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH running job is completely untouched by the reclaim attempt");
    }

    // --- stale pending job: reclaimed, terminal timestamp set, row preserved ---
    {
      const { aiResultId } = await createParentAiResult("Stale pending fixture statement.");
      const jobId = await insertInFlightDetectDuplicatesJob(aiResultId, 0, "pending", DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(outcome.outcome === "reclaimed", "a STALE pending job returns {outcome: 'reclaimed'}");
      if (outcome.outcome === "reclaimed") assert(outcome.reclaimedJobId === jobId, "the reclaimed job id matches the original stale job");

      const after = await loadJob(jobId);
      assert(after.status === "failed", "the reclaimed row's status is 'failed'");
      assert(after.error !== null && after.error.startsWith("stale_recovery_reclaimed:"), `the reclaimed row's error starts with 'stale_recovery_reclaimed:' (got ${after.error})`);
      assert(after.completedAt !== null, "the reclaimed row has a non-null terminal completedAt timestamp");
      assert(after.id === jobId, "the original row is preserved (same id), not deleted");
    }

    // --- stale running job: reclaimed the same way ------------------------
    {
      const { aiResultId } = await createParentAiResult("Stale running fixture statement.");
      const jobId = await insertInFlightDetectDuplicatesJob(aiResultId, 0, "running", DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(outcome.outcome === "reclaimed", "a STALE running job returns {outcome: 'reclaimed'}");

      const after = await loadJob(jobId);
      assert(after.status === "failed", "the reclaimed running row's status is 'failed'");
      assert(after.completedAt !== null, "the reclaimed running row has a non-null terminal completedAt timestamp");
    }

    // --- after reclaim, a fresh pending job CAN be created despite the
    // partial unique index (migration 0018) -----------------------------
    {
      const { aiResultId } = await createParentAiResult("Post-reclaim replacement fixture statement.");
      await insertInFlightDetectDuplicatesJob(aiResultId, 0, "pending", DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const reclaimOutcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(reclaimOutcome.outcome === "reclaimed", "setup: the stale job is reclaimed before the replacement attempt");

      const replacement = await createPendingAiJob({ operation: "detect_duplicates", provider: "fake", model: "test-model", extractionAiResultId: aiResultId, extractionCandidateIndex: 0 });
      assert(replacement.ok === true, "a replacement pending job CAN be created for the same candidate after the stale job was reclaimed");
    }

    // --- no in-flight job at all: reclaim is a safe no-op -----------------
    {
      const { aiResultId } = await createParentAiResult("No-in-flight fixture statement.");
      const outcome = await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
      assert(outcome.outcome === "none", "a candidate with NO in-flight job returns {outcome: 'none'}");
    }

    // --- concurrent recovery cannot create two in-flight jobs -------------
    {
      const { aiResultId } = await createParentAiResult("Concurrency fixture statement.");
      const [first, second] = await Promise.all([
        createPendingAiJob({ operation: "detect_duplicates", provider: "fake", model: "test-model", extractionAiResultId: aiResultId, extractionCandidateIndex: 0 }),
        createPendingAiJob({ operation: "detect_duplicates", provider: "fake", model: "test-model", extractionAiResultId: aiResultId, extractionCandidateIndex: 0 }),
      ]);
      const results = [first, second];
      const succeeded = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);
      assert(succeeded.length === 1, `exactly one of the two concurrent attempts succeeds (got ${succeeded.length})`);
      assert(rejected.length === 1, `exactly one of the two concurrent attempts is rejected (got ${rejected.length})`);
      if (rejected[0] && !rejected[0].ok) {
        assert(rejected[0].reason === "already_in_flight", `the losing concurrent attempt returns 'already_in_flight' (got ${(rejected[0] as { reason: string }).reason})`);
      }
    }

    // --- REVIEWED candidate: recovery refuses even with a genuinely stale
    // in-flight job present, and leaves that row untouched ----------------
    {
      const { aiResultId } = await createParentAiResult("Reviewed-candidate recovery fixture statement.");
      const staleJobId = await insertInFlightDetectDuplicatesJob(aiResultId, 0, "pending", DETECT_DUPLICATES_RECOVERY_STALE_THRESHOLD_MS + 60_000);
      const beforeReview = await loadJob(staleJobId);

      await approveClaimProposal({
        aiResultId,
        candidateIndex: 0,
        projectId: SEEDED_PROJECT_ID,
        statement: "Reviewed-candidate recovery fixture statement.",
        slug: `pr6-recovery-reviewed-${randomUUID()}`,
        informationType: "report",
        topicIds: [],
        initialInvestigationStatus: "unverified",
        initialDevelopmentOutcome: "unknown",
        reason: "fixture approval for recovery-eligibility test",
      });

      try {
        await reclaimStaleInFlightDetectDuplicatesJob(aiResultId, 0);
        assert(false, "reviewed candidate: recovery should have thrown");
      } catch (err) {
        assert(err instanceof ProposalAlreadyReviewedForDuplicateCheckError, "reviewed candidate: recovery throws ProposalAlreadyReviewedForDuplicateCheckError");
      }

      const afterAttempt = await loadJob(staleJobId);
      assert(JSON.stringify(beforeReview) === JSON.stringify(afterAttempt), "reviewed candidate: the genuinely stale in-flight row is left completely untouched -- never reclaimed for a reviewed proposal");
    }
  } finally {
    // No incremental row cleanup -- same established convention as
    // claimProposalReview.check.ts (this file also creates
    // claim_proposal_reviews/admin_decisions/claims rows via
    // approveClaimProposal in the last case above, which FK-reference the
    // ai_results/ai_jobs fixtures created here).
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll detect_duplicates recovery mutation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
