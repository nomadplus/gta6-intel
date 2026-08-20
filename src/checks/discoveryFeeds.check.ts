/**
 * Regression check for Phase 4 PR 8 (src/db/mutations/discoveryFeeds.ts):
 * discovery feed create/update, normalize-on-write, the unique-feed-URL
 * constraint, and admin_audit_log entries.
 *
 * This exercises the REAL mutation functions (createDiscoveryFeed,
 * updateDiscoveryFeed), not a reimplementation of their logic -- both are
 * "server-only"-guarded, so this must run with `--conditions=react-server`
 * exactly as documented for ingestionAuditLogging.check.ts.
 *
 * createDiscoveryFeed/updateDiscoveryFeed call requireAdmin("editor")
 * internally, which calls getSession(). Outside a real request there is
 * no cookie to verify, so this relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID
 * fake-session path (src/lib/auth/session.ts), same as
 * ingestionAuditLogging.check.ts -- double-guarded (env var AND
 * NODE_ENV !== "production"), plus this script's own NODE_ENV refusal
 * below as a third, redundant guard.
 *
 * Writes real rows (discovery_feeds and permanent admin_audit_log
 * entries -- append-only, not deleted) and removes the non-ledger rows
 * it created afterward, in a finally block, so this is safe to run
 * repeatedly against the shared local dev database.
 *
 * Run with: npx tsx --conditions=react-server src/checks/discoveryFeeds.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, and
 * LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md "Local development")
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { adminAuditLog, discoveryFeeds } from "../db/schema";
import { createDiscoveryFeed, updateDiscoveryFeed, InvalidFeedUrlError } from "../db/mutations/discoveryFeeds";
import { normalizeUrl } from "../lib/ingestion/urlNormalization";

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

// Seeded reference data (src/db/seed/seed.ts) -- the first source row in
// a freshly seeded database ("u/gta6_insider_2021"). Any valid source id
// works here since this check is about feed CRUD, not source identity.
const SEEDED_SOURCE_ID = 1;

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
      "LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set -- required so createDiscoveryFeed's " +
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

  const createdFeedIds: number[] = [];

  async function countAuditRowsFor(entityId: number): Promise<number> {
    const rows = await db
      .select({ id: adminAuditLog.id })
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.entityType, "discovery_feed"), eq(adminAuditLog.entityId, entityId)));
    return rows.length;
  }

  try {
    console.log("=== Discovery feed CRUD (real mutation functions, --conditions=react-server) ===\n");

    // --- Scenario 1: create normalizes the submitted URL before storing it ---
    const unique = randomUUID();
    // Deliberately unnormalized: a non-root trailing slash and a tracking
    // parameter, both of which normalizeUrl() strips.
    const submittedFeedUrl = `https://example.test/feeds/pr8-${unique}/?utm_source=rss-check`;
    const expectedNormalized = normalizeUrl(submittedFeedUrl);
    if (!expectedNormalized.ok) throw new Error("Test setup error: submittedFeedUrl should normalize successfully.");

    const created = await createDiscoveryFeed({
      sourceId: SEEDED_SOURCE_ID,
      feedUrl: submittedFeedUrl,
      enabled: "true",
      pollingIntervalMinutes: 30,
    });
    createdFeedIds.push(created.id);

    assert(
      created.feedUrl === expectedNormalized.normalizedUrl,
      "stored feedUrl is the normalized form, not the submitted one"
    );
    assert(
      created.feedUrl !== submittedFeedUrl,
      "normalization actually changed the value (tracking param / trailing slash stripped)"
    );
    assert(created.enabled === true, "enabled 'true' string is stored as boolean true");
    assert(created.pollingIntervalMinutes === 30, "pollingIntervalMinutes is stored as submitted");

    const auditRowsAfterCreate = await countAuditRowsFor(created.id);
    assert(auditRowsAfterCreate === 1, `feed creation writes exactly 1 audit row (found ${auditRowsAfterCreate})`);

    // --- Scenario 2: the unique constraint rejects an equivalent (but differently-typed) duplicate ---
    // Already-normalized form of the same URL -- no trailing slash, no
    // tracking param -- must collide with the row above once BOTH pass
    // through normalizeUrl(), proving the constraint works on normalized
    // identity, not literal string identity.
    const alreadyNormalizedDuplicate = expectedNormalized.normalizedUrl;
    let duplicateRejected = false;
    try {
      const dup = await createDiscoveryFeed({
        sourceId: SEEDED_SOURCE_ID,
        feedUrl: alreadyNormalizedDuplicate,
        enabled: "true",
        pollingIntervalMinutes: 60,
      });
      createdFeedIds.push(dup.id); // only reached if this incorrectly succeeded
    } catch {
      duplicateRejected = true;
    }
    assert(
      duplicateRejected,
      "submitting an equivalent feed URL (different literal string, same normalized form) is rejected as a duplicate"
    );

    // --- Scenario 3: an invalid feed URL is rejected before any row is written ---
    let invalidRejected = false;
    try {
      await createDiscoveryFeed({
        sourceId: SEEDED_SOURCE_ID,
        feedUrl: "ftp://example.test/feed.xml",
        enabled: "true",
        pollingIntervalMinutes: 60,
      });
    } catch (err) {
      invalidRejected = err instanceof InvalidFeedUrlError;
    }
    assert(invalidRejected, "an unsupported-scheme feed URL is rejected with InvalidFeedUrlError");

    // --- Scenario 4: update changes fields and writes a second audit row ---
    const updatedFeedUrl = `https://example.test/feeds/pr8-${unique}-updated`;
    const updated = await updateDiscoveryFeed({
      feedId: created.id,
      sourceId: SEEDED_SOURCE_ID,
      feedUrl: updatedFeedUrl,
      enabled: "false",
      pollingIntervalMinutes: 120,
    });
    assert(updated?.feedUrl === updatedFeedUrl, "update stores the new (already-normalized) feed URL");
    assert(updated?.enabled === false, "update stores enabled 'false' string as boolean false");
    assert(updated?.pollingIntervalMinutes === 120, "update stores the new polling interval");

    const auditRowsAfterUpdate = await countAuditRowsFor(created.id);
    assert(
      auditRowsAfterUpdate === 2,
      `update adds a 2nd audit row, for a total of 2 (found ${auditRowsAfterUpdate})`
    );

    const [row] = await db.select().from(discoveryFeeds).where(eq(discoveryFeeds.id, created.id));
    assert(row?.feedUrl === updatedFeedUrl, "database row reflects the update");
    assert(row?.enabled === false, "database row reflects enabled=false after update");
  } finally {
    // admin_audit_log rows are NOT deleted -- append-only by design
    // (migration 0004's trigger), same as ingestionAuditLogging.check.ts.
    // Only the discovery_feeds rows this check created are removed.
    for (const feedId of createdFeedIds) {
      await db.delete(discoveryFeeds).where(eq(discoveryFeeds.id, feedId));
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} discovery feed check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll discovery feed checks passed.");
  }
}

main();
