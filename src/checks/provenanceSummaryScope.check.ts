/**
 * Phase 6 PR-C regression check: proves, against a REAL local Postgres
 * database, that the new claim-scoped provenance queries
 * (getAttachedSourceItemIdsForClaim / getClaimScopedSourceRelationships in
 * src/db/queries/admin/index.ts) enforce the locked PR-C scope rule --
 * a source_relationships row may affect a claim's provenance summary
 * ONLY when BOTH endpoints are attached to that EXACT claim via
 * claim_sources.
 *
 * Covers:
 *   - a relationship with only ONE endpoint attached to the claim under
 *     test is EXCLUDED
 *   - a relationship with BOTH endpoints attached to the claim under test
 *     is INCLUDED
 *   - a source item shared between two claims does NOT leak a
 *     relationship whose other endpoint belongs only to the OTHER claim
 *     into this claim's scoped result -- this is the specific scenario
 *     the investigation identified as a real, reachable state (claim_sources
 *     has no uniqueness on sourceItemId alone)
 *   - the resulting rows feed computeClaimProvenanceSummary correctly,
 *     with no trace of the excluded external relationship in the summary
 *     (no phantom root/edge/component attributable to it)
 *
 * getClaimProvenanceChain (src/db/queries/claimDetail.ts) and
 * ProvenanceChain.tsx are UNTOUCHED by PR-C and are not exercised here.
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/provenanceSummaryScope.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { claims, sources, sourceItems, sourceTypes, sourceItemTypes, claimSources, sourceRelationships } from "../db/schema";
import { adminDb } from "../db/adminClient";
import { getAttachedSourceItemIdsForClaim, getClaimScopedSourceRelationships } from "../db/queries/admin";
import { computeClaimProvenanceSummary } from "../lib/provenanceSummary";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    failures++;
  }
}

const SEEDED_PROJECT_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this check performs real database writes.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL is not set. The functions under test (getAttachedSourceItemIdsForClaim / getClaimScopedSourceRelationships) run against adminDb.");
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  async function createTestClaim(statement: string): Promise<number> {
    const [row] = await db
      .insert(claims)
      .values({ projectId: SEEDED_PROJECT_ID, slug: `pr-c-scope-claim-${randomUUID()}`, statement, informationType: "report" })
      .returning();
    return row.id;
  }

  const [aSourceType] = await db.select().from(sourceTypes).limit(1);
  const [aSourceItemType] = await db.select().from(sourceItemTypes).limit(1);
  if (!aSourceType || !aSourceItemType) throw new Error("Seed data missing: expected at least one source_types/source_item_types row. Run npm run db:seed first.");

  async function createTestSourceItem(): Promise<number> {
    const [src] = await db.insert(sources).values({ name: `PR-C scope fixture source ${randomUUID()}`, sourceTypeId: aSourceType.id }).returning();
    const [item] = await db
      .insert(sourceItems)
      .values({ sourceId: src.id, itemTypeId: aSourceItemType.id, url: `https://example.test/pr-c-scope-${randomUUID()}` })
      .returning();
    return item.id;
  }

  async function attach(claimId: number, sourceItemId: number): Promise<void> {
    await db.insert(claimSources).values({ claimId, sourceItemId, stance: "mentions" });
  }

  async function createRelationship(a: number, b: number, type: "citation"): Promise<void> {
    await db.insert(sourceRelationships).values({ sourceItemIdA: a, sourceItemIdB: b, relationshipType: type });
  }

  try {
    console.log("=== claim-scoped provenance query (Phase 6 PR-C) -- real DB, scope-leak regression ===\n");

    const claim1 = await createTestClaim("Claim 1 fixture (PR-C scope check).");
    const claim2 = await createTestClaim("Claim 2 fixture (PR-C scope check).");

    const A = await createTestSourceItem();
    const B = await createTestSourceItem();
    const C = await createTestSourceItem(); // shared between claim1 and claim2
    const D = await createTestSourceItem(); // attached only to claim2

    await attach(claim1, A);
    await attach(claim1, B);
    await attach(claim1, C);
    await attach(claim2, C); // C is shared across both claims
    await attach(claim2, D);

    // Both endpoints attached to claim1 -> must be INCLUDED.
    await createRelationship(A, B, "citation");
    await createRelationship(B, C, "citation");

    // Only ONE endpoint (A) attached to claim1; D belongs only to claim2 ->
    // must be EXCLUDED from claim1's scoped result.
    await createRelationship(A, D, "citation");

    // C is attached to BOTH claims, but D is attached only to claim2 -> this
    // relationship must be excluded from claim1's scope even though C is
    // one of claim1's own attached sources. This is the specific
    // shared-source-item leak scenario.
    await createRelationship(C, D, "citation");

    const attachedIds = await getAttachedSourceItemIdsForClaim(adminDb, claim1);
    assert(attachedIds.length === 3, "claim1: exactly 3 attached source items");
    assert(new Set(attachedIds).has(A) && new Set(attachedIds).has(B) && new Set(attachedIds).has(C), "claim1: attached set is exactly {A, B, C}");
    assert(!new Set(attachedIds).has(D), "claim1: D (attached only to claim2) is NOT in claim1's attached set");

    const scoped = await getClaimScopedSourceRelationships(adminDb, attachedIds);
    const scopedPairs = new Set(scoped.map((r) => `${r.sourceItemIdA}:${r.sourceItemIdB}`));

    assert(scoped.length === 2, "claim1 scoped relationships: exactly 2 rows (A-B and B-C), NOT 4");
    assert(scopedPairs.has(`${A}:${B}`), "claim1 scoped relationships: A-B (both endpoints attached) is INCLUDED");
    assert(scopedPairs.has(`${B}:${C}`), "claim1 scoped relationships: B-C (both endpoints attached) is INCLUDED");
    assert(!scopedPairs.has(`${A}:${D}`), "claim1 scoped relationships: A-D (D not attached to claim1) is EXCLUDED");
    assert(!scopedPairs.has(`${C}:${D}`), "claim1 scoped relationships: C-D (D not attached to claim1, despite C being shared) is EXCLUDED -- no cross-claim leak via a shared source item");

    // Integration check: the excluded external relationship (C-D) must
    // leave no trace in the computed summary -- e.g. it must not make D
    // appear anywhere, and must not silently connect C to a component that
    // only exists because of an out-of-scope source.
    const summary = computeClaimProvenanceSummary(claim1, attachedIds, scoped);
    assert(summary.totalAttachedSources === 3, "claim1 summary: totalAttachedSources reflects only claim1's own 3 sources, not D");
    assert(summary.connectedComponentCount === 1, "claim1 summary: A-B-C form a single connected component via the two in-scope edges only");
    assert(
      !summary.reviewedGraphRootIds.includes(D) && !summary.independentSourceIds.includes(D),
      "claim1 summary: D never appears anywhere in the summary output"
    );

    console.log(failures === 0 ? "\nAll claim-scoped provenance query checks passed." : `\n${failures} total check(s) FAILED.`);
  } finally {
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
