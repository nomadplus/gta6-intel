/**
 * DB-backed regression check for Phase 4 PR 7: persisted ingestion review
 * metadata (migration 0009) and the History-page re-signing/confirmation
 * path (`prepareHistoryReviewConfirmation`, `db/mutations/ingestion.ts`).
 *
 * This exercises the REAL functions end-to-end, not a reimplementation of
 * their logic -- `completeJobReviewOutcome`, `prepareHistoryReviewConfirmation`,
 * and `finalizeIngestionConfirmation` are all "server-only"-guarded, so
 * this must run with `--conditions=react-server`, exactly as documented for
 * `ingestionAuditLogging.check.ts`.
 *
 * `prepareHistoryReviewConfirmation` and `finalizeIngestionConfirmation`
 * both call `requireAdmin("editor")` internally, so this relies on the same
 * `LOCAL_FAKE_ADMIN_AUTH_USER_ID` fake-session path as
 * `ingestionAuditLogging.check.ts`, with the same production guard.
 *
 * Proves, in order:
 *   1. `completeJobReviewOutcome` actually persists the extracted metadata
 *      to the new migration-0009 columns (read back directly, not inferred).
 *   2. `prepareHistoryReviewConfirmation` loads a still-open `needs_review`
 *      job and returns metadata matching exactly what was persisted.
 *   3. The review token it derives is signed ONLY from those persisted
 *      values (decoded via `verifyReviewPayload` and compared field-by-field
 *      against the DB row -- not merely "does it verify").
 *   4. That token finalizes successfully through the existing,
 *      UNMODIFIED `finalizeIngestionConfirmation`.
 *   5. Exactly one `source_items` row is created.
 *   6. The job transitions to `stored` and links to that row.
 *   7. Tampering/misuse still fails: a token re-signed for job A does not
 *      verify against job B's id; a bit-flipped token fails signature
 *      verification; an already-resolved job is not re-reviewable; a job
 *      with no persisted metadata (the ambiguous-403 shape) is not
 *      reviewable either.
 *
 * Writes real rows (ingestion_jobs, source_items, permanent admin_audit_log
 * entries) and removes the non-ledger rows it created afterward, in a
 * finally block -- safe to run repeatedly against the shared local dev
 * database, same convention as ingestionAuditLogging.check.ts.
 *
 * Run with: npx tsx --conditions=react-server src/checks/ingestionReviewRecovery.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, INGESTION_REVIEW_SIGNING_SECRET,
 * and LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { ingestionJobs, sourceItems } from "../db/schema";
import {
  findOrCreateIngestionJob,
  completeJobReviewOutcome,
  prepareHistoryReviewConfirmation,
  finalizeIngestionConfirmation,
  JobNotReviewableError,
} from "../db/mutations/ingestion";
import { verifyReviewPayload, InvalidReviewTokenError } from "../lib/ingestion/reviewPayloadSigning";
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

async function assertThrows(fn: () => Promise<unknown>, message: string, check?: (err: unknown) => boolean) {
  try {
    await fn();
    console.error(`FAIL: ${message} (did not throw)`);
    failures++;
  } catch (err) {
    if (check && !check(err)) {
      console.error(`FAIL: ${message} (threw, but not the expected error: ${(err as Error)?.message})`);
      failures++;
    } else {
      console.log(`PASS: ${message}`);
    }
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

// Seeded reference data (src/db/seed/seed.ts / migration 0001).
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function createNeedsReviewJob(
  db: ReturnType<typeof drizzle>,
  overrides: Partial<{
    retrievedUrl: string;
    canonicalUrl: string | null;
    rawContentHash: string;
    extractedTitle: string | null;
    extractedAuthor: string | null;
    extractedExcerpt: string | null;
  }> = {}
) {
  const testUrl = `https://example.test/pr7-review-recovery-${randomUUID()}`;
  const jobResult = await findOrCreateIngestionJob({
    submittedUrl: testUrl,
    normalizedUrl: testUrl,
    admin: EDITOR,
  });

  const rawContentHash = overrides.rawContentHash ?? "b".repeat(64);
  await completeJobReviewOutcome({
    jobId: jobResult.job.id,
    status: "needs_review",
    httpStatus: 200,
    contentType: "text/html",
    contentLength: 1234,
    reviewMetadata:
      overrides.rawContentHash === null
        ? null
        : {
            retrievedUrl: overrides.retrievedUrl ?? testUrl,
            canonicalUrl: overrides.canonicalUrl ?? null,
            rawContentHash,
            extractedTitle: overrides.extractedTitle ?? "PR 7 Review Recovery Check Title",
            extractedAuthor: overrides.extractedAuthor ?? "Test Author",
            extractedPublishedAt: null,
            extractedExcerpt: overrides.extractedExcerpt ?? "A short excerpt for the review-recovery check.",
            extractedLinksStaging: [],
          },
  });

  return { jobId: jobResult.job.id, testUrl, rawContentHash };
}

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
      "LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so prepareHistoryReviewConfirmation's " +
        "and finalizeIngestionConfirmation's internal requireAdmin() calls can resolve a session " +
        "outside a real request. See README.md."
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

  try {
    console.log("=== Ingestion review recovery (real functions, --conditions=react-server) ===\n");

    // --- 1. Metadata is actually persisted to the migration-0009 columns ---
    const { jobId, testUrl, rawContentHash } = await createNeedsReviewJob(db, {
      canonicalUrl: "https://example.test/canonical-pr7-check",
    });
    createdJobIds.push(jobId);

    const [persistedRow] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    assert(persistedRow?.status === "needs_review", "job persisted with status 'needs_review'");
    assert(persistedRow?.retrievedUrl === testUrl, "retrievedUrl persisted to the new column");
    assert(
      persistedRow?.canonicalUrl === "https://example.test/canonical-pr7-check",
      "canonicalUrl persisted to the new column"
    );
    assert(persistedRow?.rawContentHash === rawContentHash, "rawContentHash persisted to the new column");
    assert(persistedRow?.extractedTitle === "PR 7 Review Recovery Check Title", "extractedTitle persisted");
    assert(persistedRow?.extractedAuthor === "Test Author", "extractedAuthor persisted");
    assert(
      persistedRow?.extractedExcerpt === "A short excerpt for the review-recovery check.",
      "extractedExcerpt persisted"
    );

    // --- 2/3. A true needs_review job loads from History; the re-signed
    // token is derived ONLY from those persisted values -----------------
    const preparation = await prepareHistoryReviewConfirmation(jobId);
    assert(preparation.jobId === jobId, "preparation resolves to the correct jobId");
    assert(preparation.metadata.url === testUrl, "preparation metadata.url matches the persisted retrievedUrl");
    assert(
      preparation.metadata.canonicalUrl === "https://example.test/canonical-pr7-check",
      "preparation metadata.canonicalUrl matches the persisted value"
    );
    assert(
      preparation.metadata.rawContentHash === rawContentHash,
      "preparation metadata.rawContentHash matches the persisted value"
    );

    const decodedToken = verifyReviewPayload(preparation.reviewToken, jobId);
    assert(decodedToken.url === persistedRow!.retrievedUrl, "re-signed token's url matches the DB row, not any other source");
    assert(
      decodedToken.rawContentHash === persistedRow!.rawContentHash,
      "re-signed token's rawContentHash matches the DB row"
    );
    assert(
      decodedToken.canonicalUrl === persistedRow!.canonicalUrl,
      "re-signed token's canonicalUrl matches the DB row"
    );

    // --- 4/5/6. The re-signed token finalizes through the UNMODIFIED
    // finalizeIngestionConfirmation; exactly one source_items row is
    // created; the job transitions and links correctly ------------------
    const confirmResult = await finalizeIngestionConfirmation({
      jobId,
      sourceId: SEEDED_SOURCE_ID,
      itemTypeId: SEEDED_ITEM_TYPE_ID,
      reviewToken: preparation.reviewToken,
    });
    createdSourceItemIds.push(confirmResult.sourceItemId);

    const matchingSourceItems = await db
      .select({ id: sourceItems.id })
      .from(sourceItems)
      .where(eq(sourceItems.rawContentHash, rawContentHash));
    assert(matchingSourceItems.length === 1, `exactly one source_items row created (found ${matchingSourceItems.length})`);

    const [finalJob] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    assert(finalJob?.status === "stored", "job transitions to 'stored' after History-based confirmation");
    assert(finalJob?.sourceItemId === confirmResult.sourceItemId, "job links to the created source item");

    const [createdSourceItem] = await db
      .select()
      .from(sourceItems)
      .where(eq(sourceItems.id, confirmResult.sourceItemId));
    assert(createdSourceItem?.url === testUrl, "created source item's url matches the persisted/re-signed data");
    assert(createdSourceItem?.rawContentHash === rawContentHash, "created source item's hash matches the persisted data");

    // --- 7a. An already-resolved job is not re-reviewable ----------------
    await assertThrows(
      () => prepareHistoryReviewConfirmation(jobId),
      "an already-stored job cannot be re-prepared for History review",
      (err) => err instanceof JobNotReviewableError
    );

    // --- 7b. A job with no persisted metadata (ambiguous-403 shape) is
    // not reviewable -------------------------------------------------------
    const { jobId: noMetadataJobId } = await createNeedsReviewJob(db, { rawContentHash: null as unknown as string });
    createdJobIds.push(noMetadataJobId);
    await assertThrows(
      () => prepareHistoryReviewConfirmation(noMetadataJobId),
      "a needs_review job with no persisted metadata (e.g. ambiguous-403) is not reviewable",
      (err) => err instanceof JobNotReviewableError
    );

    // --- 7c. A nonexistent job is not reviewable -------------------------
    await assertThrows(
      () => prepareHistoryReviewConfirmation(-1),
      "a nonexistent jobId is not reviewable",
      (err) => err instanceof JobNotReviewableError
    );

    // --- 7d. A token re-signed for one job does not verify against a
    // different job's id --------------------------------------------------
    const { jobId: jobCId } = await createNeedsReviewJob(db);
    createdJobIds.push(jobCId);
    const { jobId: jobDId } = await createNeedsReviewJob(db);
    createdJobIds.push(jobDId);
    const preparationC = await prepareHistoryReviewConfirmation(jobCId);
    await assertThrows(
      () =>
        finalizeIngestionConfirmation({
          jobId: jobDId,
          sourceId: SEEDED_SOURCE_ID,
          itemTypeId: SEEDED_ITEM_TYPE_ID,
          reviewToken: preparationC.reviewToken,
        }),
      "a token signed for job C is rejected when submitted against job D's id",
      (err) => err instanceof InvalidReviewTokenError
    );

    // --- 7e. A bit-flipped token fails signature verification -------------
    const tamperedToken = preparationC.reviewToken.slice(0, -4) + "XXXX";
    assert(
      tamperedToken !== preparationC.reviewToken,
      "tampered token string actually differs from the original (sanity check on the test itself)"
    );
    let tamperFailed = false;
    try {
      verifyReviewPayload(tamperedToken, jobCId);
    } catch (err) {
      tamperFailed = err instanceof InvalidReviewTokenError;
    }
    assert(tamperFailed, "a bit-flipped token fails signature verification");
  } finally {
    // Cleanup order matters: admin_audit_log rows are append-only (migration
    // 0004's trigger) and NOT deleted here, same convention as
    // ingestionAuditLogging.check.ts. Only the non-ledger rows this check
    // created are removed, in FK order.
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
    console.error(`\n${failures} ingestion review recovery check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll ingestion review recovery checks passed.");
  }
}

main();
