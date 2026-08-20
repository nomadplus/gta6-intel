/**
 * Regression check for the Phase 4 PR 6 audit-logging behavior added to
 * src/db/mutations/ingestion.ts: creating a new ingestion job and
 * confirming one should each write specific admin_audit_log rows;
 * reusing an in-flight job should write none.
 *
 * This exercises the REAL mutation functions (findOrCreateIngestionJob,
 * finalizeIngestionConfirmation), not a reimplementation of their logic
 * -- both are "server-only"-guarded modules, so this must run with
 * `--conditions=react-server` (which resolves "server-only" to its inert
 * empty.js export instead of throwing) exactly as documented for
 * adminAuth.check.ts's server-only dependencies.
 *
 * finalizeIngestionConfirmation calls requireAdmin("editor") internally,
 * which calls getSession(). Outside a real request there is no cookie to
 * verify, so this relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID fake-session
 * path (src/lib/auth/session.ts) -- the same mechanism the project's own
 * docs describe as the intended way to exercise auth-gated server code
 * outside a real Next.js request. That path is double-guarded (env var
 * AND NODE_ENV !== "production"), so this check refuses to run at all if
 * NODE_ENV is "production", as a third, redundant guard specific to this
 * script -- it performs real writes and must never be pointed at a real
 * deployment's database.
 *
 * findOrCreateIngestionJob takes an AuthorizedAdmin directly (it has no
 * internal requireAdmin call -- prepareIngestionSubmission, its caller in
 * pipeline.ts, is what enforces that), so it's exercised directly with a
 * fabricated AdminRecord matching the seeded editor row, no fake-session
 * needed for that half of this check.
 *
 * Writes real rows (ingestion_jobs, source_items, and permanent
 * admin_audit_log entries -- see cleanup note below on why those aren't
 * deleted) and removes the non-ledger rows it created afterward, in a
 * finally block, so this is safe to run repeatedly against the shared
 * local dev database.
 *
 * Run with: npx tsx --conditions=react-server src/checks/ingestionAuditLogging.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, INGESTION_REVIEW_SIGNING_SECRET,
 * and LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { adminAuditLog, ingestionJobs, sourceItems } from "../db/schema";
import { findOrCreateIngestionJob, finalizeIngestionConfirmation } from "../db/mutations/ingestion";
import { signReviewPayload } from "../lib/ingestion/reviewPayloadSigning";
import type { AuthorizedAdmin } from "../lib/auth/requireAdmin";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// Matches the seeded editor row from src/db/seed/seed.ts.
const EDITOR: AuthorizedAdmin = {
  id: 2,
  displayName: "Test Editor",
  email: "editor@example.test",
  role: "editor",
};
const EDITOR_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";

// Seeded reference data (src/db/seed/seed.ts / migration 0001) -- any
// valid source/item-type id works here, since this check is about audit
// logging, not source-identity resolution.
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes and relies on the " +
        "LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass, which must never be exercised " +
        "against a production database."
    );
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error(
      "LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so finalizeIngestionConfirmation's " +
        "internal requireAdmin() call can resolve a session outside a real request. See README.md."
    );
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error("CHECK_DATABASE_URL is not set. See README.md (\"Test / check commands\").");
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  const createdJobIds: number[] = [];
  const createdSourceItemIds: number[] = [];

  async function countAuditRowsFor(entityType: "ingestion_job" | "source_item", entityId: number): Promise<number> {
    const rows = await db
      .select({ id: adminAuditLog.id })
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.entityType, entityType), eq(adminAuditLog.entityId, entityId)));
    return rows.length;
  }

  try {
    console.log("=== Ingestion audit logging (real mutation functions, --conditions=react-server) ===\n");

    // --- Scenario 1: creating a new job logs exactly one ingestion_job audit row ---
    const testUrl = `https://example.test/pr6-audit-check-${randomUUID()}`;
    const firstResult = await findOrCreateIngestionJob({
      submittedUrl: testUrl,
      normalizedUrl: testUrl,
      admin: EDITOR,
    });
    assert(!firstResult.reused, "first submission creates a new job (not reused)");
    createdJobIds.push(firstResult.job.id);

    const auditRowsAfterCreate = await countAuditRowsFor("ingestion_job", firstResult.job.id);
    assert(auditRowsAfterCreate === 1, `job creation writes exactly 1 audit row (found ${auditRowsAfterCreate})`);

    // --- Scenario 2: reusing an in-flight job (same normalizedUrl, still 'queued') logs nothing new ---
    const secondResult = await findOrCreateIngestionJob({
      submittedUrl: testUrl,
      normalizedUrl: testUrl,
      admin: EDITOR,
    });
    assert(secondResult.reused, "second submission of the same in-flight URL is reused, not recreated");
    assert(secondResult.job.id === firstResult.job.id, "reused result is the same job id");

    const auditRowsAfterReuse = await countAuditRowsFor("ingestion_job", firstResult.job.id);
    assert(
      auditRowsAfterReuse === 1,
      `reusing an in-flight job adds no new audit row (still ${auditRowsAfterReuse}, was ${auditRowsAfterCreate})`
    );

    // --- Scenario 3: confirming a job logs a source_item create + an ingestion_job update ---
    // Move the job to 'needs_review' with no linked source item directly --
    // the classification pipeline that produces this state is already
    // covered by ingestionDuplicateDetection.check.ts / ingestionSourceIdentity.check.ts;
    // this check is specifically about what finalizeIngestionConfirmation logs.
    await db
      .update(ingestionJobs)
      .set({ status: "needs_review", sourceItemId: null })
      .where(eq(ingestionJobs.id, firstResult.job.id));

    const fakeRawContentHash = "a".repeat(64); // well-formed-looking SHA-256 hex digest for schema validation only
    const reviewToken = signReviewPayload({
      jobId: firstResult.job.id,
      url: testUrl,
      canonicalUrl: null,
      excerpt: null,
      rawContentHash: fakeRawContentHash,
    });

    const confirmResult = await finalizeIngestionConfirmation({
      jobId: firstResult.job.id,
      sourceId: SEEDED_SOURCE_ID,
      itemTypeId: SEEDED_ITEM_TYPE_ID,
      reviewToken,
    });
    createdSourceItemIds.push(confirmResult.sourceItemId);

    const sourceItemAuditRows = await countAuditRowsFor("source_item", confirmResult.sourceItemId);
    assert(
      sourceItemAuditRows === 1,
      `confirmation writes exactly 1 source_item audit row (found ${sourceItemAuditRows})`
    );

    const jobAuditRowsAfterConfirm = await countAuditRowsFor("ingestion_job", firstResult.job.id);
    assert(
      jobAuditRowsAfterConfirm === 2,
      `confirmation adds a 2nd ingestion_job audit row, for a total of 2 (found ${jobAuditRowsAfterConfirm})`
    );

    const [confirmedJob] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, firstResult.job.id));
    assert(confirmedJob?.status === "stored", "job status is 'stored' after confirmation");
    assert(confirmedJob?.sourceItemId === confirmResult.sourceItemId, "job is linked to the created source item");

    const [createdSourceItem] = await db
      .select()
      .from(sourceItems)
      .where(eq(sourceItems.id, confirmResult.sourceItemId));
    assert(createdSourceItem?.url === testUrl, "created source item's url matches the signed review payload, not any tampered field");
  } finally {
    // Cleanup order matters: admin_audit_log rows are NOT deleted here --
    // that table is append-only by design (BEFORE UPDATE OR DELETE trigger,
    // migration 0004), same as the two status-history ledgers. This check
    // deliberately leaves its audit trail in place, exactly as a real
    // confirm/submit action would -- attempting to delete it would fail
    // against the trigger and is not the correct behavior to clean up
    // anyway. Only the non-ledger rows this check created (the test
    // ingestion_jobs row and, if confirmation ran, its source_items row)
    // are removed, in FK order (source_item_id nulled before the job's
    // source_items row can be deleted).
    for (const jobId of createdJobIds) {
      await db.update(ingestionJobs).set({ sourceItemId: null }).where(eq(ingestionJobs.id, jobId));
    }
    for (const sourceItemId of createdSourceItemIds) {
      await db.delete(sourceItems).where(eq(sourceItems.id, sourceItemId));
    }
    for (const jobId of createdJobIds) {
      await db.delete(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} ingestion audit logging check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll ingestion audit logging checks passed.");
  }
}

main();
