/**
 * Phase 6 prerequisite regression check: source_item_links persistence,
 * forward/retroactive resolution, and the partial-immutability trigger.
 * Exercises the REAL mutation functions (findOrCreateIngestionJob,
 * completeJobReviewOutcome, finalizeIngestionConfirmation), not a
 * reimplementation of their logic -- same rationale/pattern as
 * ingestionAuditLogging.check.ts.
 *
 * Proves:
 *   - confirming a job with staged links promotes them into durable
 *     source_item_links rows, from_source_item_id = the new item
 *   - FORWARD resolution: a staged link whose target uniquely matches an
 *     already-existing source_items row resolves at confirmation time
 *   - zero matches -> stays unresolved; >1 distinct matches (ambiguous) ->
 *     stays unresolved -- never guessed
 *   - a self-referential link (this new item linking to its own URL) never
 *     resolves to itself
 *   - RETROACTIVE resolution: confirming a new item resolves other,
 *     pre-existing unresolved links whose target uniquely matches it
 *   - an already-resolved row is never touched by a later retroactive pass
 *   - UNIQUE (ingestion_job_id, link_position) rejects a duplicate insert
 *   - the partial-immutability trigger: the ONE legal enrichment update
 *     succeeds; every other UPDATE shape and every DELETE is rejected
 *
 * Run with: npx tsx --conditions=react-server src/checks/sourceItemLinks.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, INGESTION_REVIEW_SIGNING_SECRET,
 * LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 *
 * Cleanup note: like sourceRelationshipReview.check.ts, this check does NOT
 * delete its source_items/ingestion_jobs/source_item_links fixtures
 * afterward -- source_item_links' own append-only trigger makes that
 * impossible in general (a resolved row can never be deleted), and once any
 * such row references a source_items/ingestion_jobs row, those become
 * permanently un-deletable too (RESTRICT FKs). This matches the project's
 * existing convention for checks that create append-only-ledger-referenced
 * fixtures: unique randomUUID-derived values keep repeated runs from
 * colliding, and the rows are simply left in the local dev database.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { sourceItems, sourceItemLinks } from "../db/schema";
import { findOrCreateIngestionJob, completeJobReviewOutcome, finalizeIngestionConfirmation } from "../db/mutations/ingestion";
import { signReviewPayload } from "../lib/ingestion/reviewPayloadSigning";
import type { ExtractedLink } from "../lib/ingestion/linkExtraction";
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

const EDITOR: AuthorizedAdmin = { id: 2, displayName: "Test Editor", email: "editor@example.test", role: "editor" };
const EDITOR_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

function fakeHash(): string {
  return randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
}

function baseLink(overrides: Partial<ExtractedLink> & { normalizedTargetUrl: string; targetUrl: string }): ExtractedLink {
  return {
    linkPosition: 0,
    anchorText: "a link",
    contextSnippet: "some surrounding text",
    relAttribute: null,
    placement: "content",
    isSameSite: false,
    ...overrides,
  };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this check performs real database writes.");
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set. See README.md.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  /** Drives a job all the way to 'needs_review' with staged links, then confirms it -- mirrors ingestionAuditLogging.check.ts's Scenario 3 pattern, extended with extractedLinksStaging. */
  async function ingestAndConfirm(url: string, stagedLinks: ExtractedLink[]): Promise<{ jobId: number; sourceItemId: number }> {
    const jobResult = await findOrCreateIngestionJob({ submittedUrl: url, normalizedUrl: url, admin: EDITOR });
    const rawContentHash = fakeHash();

    await completeJobReviewOutcome({
      jobId: jobResult.job.id,
      status: "needs_review",
      httpStatus: 200,
      contentType: "text/html",
      contentLength: 1000,
      reviewMetadata: {
        retrievedUrl: url,
        canonicalUrl: null,
        rawContentHash,
        extractedTitle: "Test Title",
        extractedAuthor: null,
        extractedPublishedAt: null,
        extractedExcerpt: null,
        extractedLinksStaging: stagedLinks,
      },
    });

    const reviewToken = signReviewPayload({ jobId: jobResult.job.id, url, canonicalUrl: null, excerpt: null, rawContentHash });
    const confirmResult = await finalizeIngestionConfirmation({
      jobId: jobResult.job.id,
      sourceId: SEEDED_SOURCE_ID,
      itemTypeId: SEEDED_ITEM_TYPE_ID,
      reviewToken,
    });

    return { jobId: jobResult.job.id, sourceItemId: confirmResult.sourceItemId };
  }

  async function linksForJob(jobId: number) {
    return db.select().from(sourceItemLinks).where(eq(sourceItemLinks.ingestionJobId, jobId));
  }

  try {
    console.log("=== source_item_links persistence, resolution, and trigger invariants (Phase 6 prerequisite) ===\n");

    // --- promotion + forward resolution against an EXISTING target --------
    {
      const existingUrl = `https://example.test/sil-existing-${randomUUID()}`;
      const existing = await ingestAndConfirm(existingUrl, []);

      const fromUrl = `https://example.test/sil-from-${randomUUID()}`;
      const staged = [
        baseLink({ linkPosition: 0, targetUrl: existingUrl, normalizedTargetUrl: existingUrl }),
      ];
      const from = await ingestAndConfirm(fromUrl, staged);

      const rows = await linksForJob(from.jobId);
      assert(rows.length === 1, `exactly one source_item_links row promoted for this job (found ${rows.length})`);
      assert(rows[0]?.fromSourceItemId === from.sourceItemId, "promoted row's from_source_item_id is the newly created item");
      assert(rows[0]?.toSourceItemId === existing.sourceItemId, "FORWARD resolution: unique existing target resolves at confirmation time");
      assert(rows[0]?.resolvedAt !== null, "resolved_at is set together with to_source_item_id");
    }

    // --- zero matches -> stays unresolved -----------------------------------
    {
      const neverIngestedUrl = `https://example.test/sil-never-ingested-${randomUUID()}`;
      const fromUrl = `https://example.test/sil-from2-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl: neverIngestedUrl, normalizedTargetUrl: neverIngestedUrl })];
      const from = await ingestAndConfirm(fromUrl, staged);
      const rows = await linksForJob(from.jobId);
      assert(rows[0]?.toSourceItemId === null, "zero matches -> to_source_item_id remains NULL");
      assert(rows[0]?.resolvedAt === null, "zero matches -> resolved_at remains NULL");
    }

    // --- ambiguous (2+ distinct matches) -> stays unresolved ----------------
    {
      const sharedUrl = `https://example.test/sil-shared-${randomUUID()}`;
      const first = await ingestAndConfirm(sharedUrl, []);
      // Force a second, distinct source_items row to share the exact same
      // normalized_url -- the real "hash-mismatch re-ingestion" case, done
      // directly here for test setup speed rather than replaying the whole
      // pipeline's hash-mismatch branch (already covered by
      // ingestionDuplicateDetection.check.ts).
      const [secondRow] = await db
        .insert(sourceItems)
        .values({ sourceId: SEEDED_SOURCE_ID, itemTypeId: SEEDED_ITEM_TYPE_ID, url: sharedUrl, normalizedUrl: sharedUrl, rawContentHash: fakeHash() })
        .returning();
      assert(!!secondRow, "setup: second source_items row sharing the URL created");

      const fromUrl = `https://example.test/sil-from3-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl: sharedUrl, normalizedTargetUrl: sharedUrl })];
      const from = await ingestAndConfirm(fromUrl, staged);
      const rows = await linksForJob(from.jobId);
      assert(rows[0]?.toSourceItemId === null, `ambiguous (2 distinct source_items share this URL) -> stays unresolved, never guessed (first=${first.sourceItemId}, second=${secondRow!.id})`);
    }

    // --- self-link never resolves -------------------------------------------
    {
      const selfUrl = `https://example.test/sil-self-${randomUUID()}`;
      // This item's own extracted links include a permalink pointing at
      // its own (not-yet-existing, at extraction time) URL.
      const staged = [baseLink({ linkPosition: 0, targetUrl: selfUrl, normalizedTargetUrl: selfUrl })];
      const self = await ingestAndConfirm(selfUrl, staged);
      const rows = await linksForJob(self.jobId);
      assert(rows[0]?.toSourceItemId === null, "a self-referential link (target URL == this item's own URL) never resolves to itself");
    }

    // --- RETROACTIVE resolution: pre-existing unresolved link resolves later ---
    {
      const futureUrl = `https://example.test/sil-future-${randomUUID()}`;
      const fromUrl = `https://example.test/sil-retro-from-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl: futureUrl, normalizedTargetUrl: futureUrl })];
      const from = await ingestAndConfirm(fromUrl, staged);
      const beforeRows = await linksForJob(from.jobId);
      assert(beforeRows[0]?.toSourceItemId === null, "setup: link to a not-yet-ingested URL starts unresolved");

      // Now the target actually gets ingested.
      const future = await ingestAndConfirm(futureUrl, []);

      const afterRows = await linksForJob(from.jobId);
      assert(afterRows[0]?.toSourceItemId === future.sourceItemId, "RETROACTIVE resolution: the earlier unresolved link now resolves to the newly confirmed item");
      assert(afterRows[0]?.resolvedAt !== null, "retroactive resolution sets resolved_at");
    }

    // --- already-resolved row is never touched by a later retroactive pass ---
    {
      const targetUrl = `https://example.test/sil-already-resolved-target-${randomUUID()}`;
      const target = await ingestAndConfirm(targetUrl, []);

      const fromUrl = `https://example.test/sil-already-resolved-from-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl, normalizedTargetUrl: targetUrl })];
      const from = await ingestAndConfirm(fromUrl, staged);
      const resolvedRows = await linksForJob(from.jobId);
      const resolvedAtFirst = resolvedRows[0]?.resolvedAt?.getTime();
      assert(resolvedRows[0]?.toSourceItemId === target.sourceItemId, "setup: link resolves to the existing target");

      // Confirm ANOTHER, unrelated item -- this must not touch the
      // already-resolved row above at all.
      await ingestAndConfirm(`https://example.test/sil-unrelated-${randomUUID()}`, []);

      const rowsAfterUnrelatedConfirm = await linksForJob(from.jobId);
      assert(
        rowsAfterUnrelatedConfirm[0]?.toSourceItemId === target.sourceItemId &&
          rowsAfterUnrelatedConfirm[0]?.resolvedAt?.getTime() === resolvedAtFirst,
        "an already-resolved row's to_source_item_id/resolved_at are byte-identical after an unrelated later confirmation -- never re-touched"
      );
    }

    // --- duplicate target at two positions preserved as two distinct rows ---
    {
      const targetUrl = `https://example.test/sil-dup-target-${randomUUID()}`;
      const fromUrl = `https://example.test/sil-dup-from-${randomUUID()}`;
      const staged = [
        baseLink({ linkPosition: 0, targetUrl, normalizedTargetUrl: targetUrl, anchorText: "first mention" }),
        baseLink({ linkPosition: 3, targetUrl, normalizedTargetUrl: targetUrl, anchorText: "second mention" }),
      ];
      const from = await ingestAndConfirm(fromUrl, staged);
      const rows = await linksForJob(from.jobId);
      assert(rows.length === 2, `two occurrences of the same target are both persisted as distinct rows (found ${rows.length})`);
    }

    // --- UNIQUE (ingestion_job_id, link_position) rejects a duplicate insert ---
    {
      const fromUrl = `https://example.test/sil-uniq-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl: "https://other.test/x", normalizedTargetUrl: "https://other.test/x" })];
      const from = await ingestAndConfirm(fromUrl, staged);

      let rejected = false;
      try {
        await db.insert(sourceItemLinks).values({
          fromSourceItemId: from.sourceItemId,
          targetUrl: "https://other.test/y",
          normalizedTargetUrl: "https://other.test/y",
          linkPosition: 0, // same (ingestion_job_id, link_position) as the row already inserted above
          placement: "content",
          isSameSite: false,
          ingestionJobId: from.jobId,
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "UNIQUE (ingestion_job_id, link_position) rejects a duplicate-position insert for the same job");
    }

    // --- Trigger invariants --------------------------------------------------
    {
      const fromUrl = `https://example.test/sil-trigger-${randomUUID()}`;
      const staged = [baseLink({ linkPosition: 0, targetUrl: "https://other.test/trigger-target", normalizedTargetUrl: "https://other.test/trigger-target" })];
      const from = await ingestAndConfirm(fromUrl, staged);
      const [row] = await linksForJob(from.jobId);
      const linkId = row!.id;

      // Confirm it starts unresolved (no existing item matches this made-up target).
      assert(row!.toSourceItemId === null, "trigger-invariant setup: row starts unresolved");

      const [otherTarget] = await db
        .insert(sourceItems)
        .values({ sourceId: SEEDED_SOURCE_ID, itemTypeId: SEEDED_ITEM_TYPE_ID, url: `https://other.test/trigger-other-${randomUUID()}`, rawContentHash: fakeHash() })
        .returning();

      // target-only update (resolved_at stays NULL) -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET to_source_item_id = ${otherTarget!.id} WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: target-only update (resolved_at not set)");
      }

      // resolved-at-only update -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET resolved_at = now() WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: resolved-at-only update (to_source_item_id not set)");
      }

      // observation-column update -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET anchor_text = 'changed' WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: an observation-column update (anchor_text)");
      }

      // no-op update -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET id = id WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: a no-op update");
      }

      // the ONE legal transition -- succeeds
      {
        let succeeded = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET to_source_item_id = ${otherTarget!.id}, resolved_at = now() WHERE id = ${linkId}`);
          succeeded = true;
        } catch {
          succeeded = false;
        }
        assert(succeeded, "trigger allows: the one legal NULL->target + NULL->resolved_at transition, together");
      }

      // second resolution attempt -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`UPDATE source_item_links SET to_source_item_id = ${otherTarget!.id}, resolved_at = now() WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: a second resolution attempt on an already-resolved row");
      }

      // DELETE -- rejected
      {
        let rejected = false;
        try {
          await db.execute(sql`DELETE FROM source_item_links WHERE id = ${linkId}`);
        } catch {
          rejected = true;
        }
        assert(rejected, "trigger rejects: DELETE, unconditionally");
      }
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} source_item_links check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll source_item_links checks passed.");
  }
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
