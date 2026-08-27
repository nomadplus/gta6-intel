/**
 * Regression check for Phase 5 PR 8b's recovery mutation
 * (src/db/mutations/provenanceAnalysisRecovery.ts) -- exercises the REAL
 * reclaimStaleInFlightProvenanceAnalysisJob() against a real local
 * Postgres database. No AI/provider call happens anywhere in this file
 * (that module is DB-only by design). Structurally an exact mirror of
 * compareClaimsRecovery.check.ts, identity narrowed to one
 * provenanceClaimId (migration 0024), proving the same race-safe
 * lock/recheck pattern (plain FOR UPDATE, not SKIP LOCKED).
 *
 * Covers:
 *   - a FRESH pending/running job is not recovery-eligible -- reclaim
 *     returns {outcome: "fresh_in_flight"} and makes NO database change
 *   - a STALE pending/running job IS recovery-eligible -- reclaim
 *     terminalizes it to 'failed', with an explicit
 *     stale_recovery_reclaimed: error AND a non-null completedAt
 *   - the reclaimed row is preserved (not deleted)
 *   - after reclaiming, a fresh pending job CAN be created for the same
 *     anchor claim despite the partial unique index (migration 0024)
 *   - two concurrent recovery attempts on a claim with NO existing
 *     in-flight job cannot both create a new in-flight job
 *   - no anchor claim with any in-flight job at all: reclaim is a safe
 *     no-op
 *   - ZERO admin_audit_log rows are written by any recovery outcome
 *     (fresh_in_flight, reclaimed, or none) -- matching the
 *     PR3/PR4/PR6/PR7 convention
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/provenanceAnalysisRecovery.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { aiJobs, claims, adminAuditLog } from "../db/schema";
import { reclaimStaleInFlightProvenanceAnalysisJob } from "../db/mutations/provenanceAnalysisRecovery";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS } from "../lib/ai/provenanceAnalysisRecoveryLifecycle";

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
const SEEDED_PROJECT_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes and relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass, which must never be exercised against a production database."
    );
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so reclaimStaleInFlightProvenanceAnalysisJob's internal requireAdmin() call can resolve a session. See README.md.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  async function createTestClaim(statement: string): Promise<number> {
    const [row] = await db.insert(claims).values({ projectId: SEEDED_PROJECT_ID, slug: `pr8b-recovery-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return row.id;
  }

  async function insertInFlightProvenanceJob(provenanceClaimId: number, status: "pending" | "running", ageMs: number): Promise<number> {
    const referenceInstant = new Date(Date.now() - ageMs);
    const [row] = await db
      .insert(aiJobs)
      .values({
        operation: "analyse_provenance",
        provider: "fake",
        model: "test-model",
        status,
        provenanceClaimId,
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

  async function countAuditLogRows(): Promise<number> {
    const rows = await db.select({ id: adminAuditLog.id }).from(adminAuditLog);
    return rows.length;
  }

  try {
    console.log("=== analyse_provenance recovery mutation (Phase 5 PR 8b) -- DB only, no AI calls ===\n");

    const auditCountBeforeAll = await countAuditLogRows();

    // --- fresh pending job: NOT recovery-eligible, no DB change -----------
    {
      const claimId = await createTestClaim("Fresh pending fixture claim.");
      const jobId = await insertInFlightProvenanceJob(claimId, "pending", 1000);
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH pending job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH pending job is completely untouched by the reclaim attempt");
    }

    // --- fresh running job: NOT recovery-eligible, no DB change -----------
    {
      const claimId = await createTestClaim("Fresh running fixture claim.");
      const jobId = await insertInFlightProvenanceJob(claimId, "running", 1000);
      const before = await loadJob(jobId);

      const outcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
      assert(outcome.outcome === "fresh_in_flight", "a FRESH running job returns {outcome: 'fresh_in_flight'}");

      const after = await loadJob(jobId);
      assert(JSON.stringify(before) === JSON.stringify(after), "a FRESH running job is completely untouched by the reclaim attempt");
    }

    // --- stale pending job: reclaimed, terminal timestamp set, row preserved ---
    {
      const claimId = await createTestClaim("Stale pending fixture claim.");
      const jobId = await insertInFlightProvenanceJob(claimId, "pending", PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
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
      const claimId = await createTestClaim("Stale running fixture claim.");
      const jobId = await insertInFlightProvenanceJob(claimId, "running", PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const outcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
      assert(outcome.outcome === "reclaimed", "a STALE running job returns {outcome: 'reclaimed'}");

      const after = await loadJob(jobId);
      assert(after.status === "failed", "the reclaimed running row's status is 'failed'");
      assert(after.completedAt !== null, "the reclaimed running row has a non-null terminal completedAt timestamp");
    }

    // --- after reclaim, a fresh pending job CAN be created despite the
    // partial unique index (migration 0024) -----------------------------
    {
      const claimId = await createTestClaim("Post-reclaim replacement fixture claim.");
      await insertInFlightProvenanceJob(claimId, "pending", PROVENANCE_ANALYSIS_RECOVERY_STALE_THRESHOLD_MS + 60_000);

      const reclaimOutcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
      assert(reclaimOutcome.outcome === "reclaimed", "setup: the stale job is reclaimed before the replacement attempt");

      const replacement = await createPendingAiJob({ operation: "analyse_provenance", provider: "fake", model: "test-model", provenanceClaimId: claimId });
      assert(replacement.ok === true, "a replacement pending job CAN be created for the same anchor claim after the stale job was reclaimed");
    }

    // --- no in-flight job at all: reclaim is a safe no-op -----------------
    {
      const claimId = await createTestClaim("No-in-flight fixture claim.");
      const outcome = await reclaimStaleInFlightProvenanceAnalysisJob(claimId);
      assert(outcome.outcome === "none", "a claim with NO in-flight job returns {outcome: 'none'}");
    }

    // --- concurrent recovery cannot create two in-flight jobs -------------
    {
      const claimId = await createTestClaim("Concurrency fixture claim.");
      const [first, second] = await Promise.all([
        createPendingAiJob({ operation: "analyse_provenance", provider: "fake", model: "test-model", provenanceClaimId: claimId }),
        createPendingAiJob({ operation: "analyse_provenance", provider: "fake", model: "test-model", provenanceClaimId: claimId }),
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

    // --- zero admin_audit_log rows written by ANY recovery outcome --------
    {
      const auditCountAfterAll = await countAuditLogRows();
      assert(
        auditCountAfterAll === auditCountBeforeAll,
        `zero admin_audit_log rows were written across every recovery outcome above (fresh_in_flight/reclaimed/none) -- count before: ${auditCountBeforeAll}, after: ${auditCountAfterAll}`
      );
    }
  } finally {
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll analyse_provenance recovery mutation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
