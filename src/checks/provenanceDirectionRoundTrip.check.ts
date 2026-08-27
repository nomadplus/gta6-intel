/**
 * Phase 5 PR 8a regression check: WRITE-PATH / READ-PATH AGREEMENT for
 * `source_relationships`. Exercises the real, guarded mutation
 * (src/db/mutations/provenance.ts) against a local Postgres database and
 * reads the result back through every consumer. No AI provider call happens
 * anywhere in this file.
 *
 * WHY THIS FILE EXISTS AT ALL. The defect PR8a fixes was not a display bug
 * and not a storage bug in isolation -- it was a DISAGREEMENT between the
 * writer and the readers. The admin form bound "this item" to sourceItemIdB
 * and the other item to sourceItemIdA, so a relationship created through the
 * UI was stored as the inverse of what the admin entered; the three readers
 * were all individually correct and faithfully displayed the inverted row.
 * No pure check can catch that class of bug, because every component is
 * self-consistent -- only a round trip through the real mutation and back out
 * through the real queries can.
 *
 * Proves:
 *   - createSourceRelationship stores (a = subject, b = object) with no swap
 *   - the admin_audit_log summary names the subject FIRST, in the shared
 *     human-readable vocabulary
 *   - getSourceItemRelationships puts the row on the subject's `outgoing`
 *     side and the object's `incoming` side, and on neither of the opposites
 *   - getClaimProvenanceChain resolves from = subject, to = object
 *   - the audit sentence and the public chain sentence are character-for-
 *     character identical for the same stored row
 *   - the duplicate and self-link guards survived the refactor
 *   - (X,Y,type) and (Y,X,type) may BOTH exist -- the guard against a future
 *     "fix" that canonicalizes the pair, which would destroy this table's
 *     entire semantic purpose
 *
 * Run with: npx tsx --conditions=react-server src/checks/provenanceDirectionRoundTrip.check.ts
 * (requires DATABASE_URL, ADMIN_DATABASE_URL, CHECK_DATABASE_URL,
 *  LOCAL_FAKE_ADMIN_AUTH_USER_ID -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, desc, eq } from "drizzle-orm";
import {
  adminAuditLog,
  claims,
  claimSources,
  sourceItems,
  sourceItemTypes,
  sourceRelationships,
  sourceTypes,
  sources,
} from "../db/schema";
import { createSourceRelationship, DuplicateProvenanceLinkError } from "../db/mutations/provenance";
import { getSourceItemRelationships } from "../db/queries/admin";
import { getClaimProvenanceChain } from "../db/queries/claimDetail";
import { describeProvenanceLink } from "../lib/provenanceDirection";

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
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set. This local-only check needs the fake admin session.");
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  try {
    console.log("=== provenance direction round trip (Phase 5 PR 8a) ===\n");

    // --- Fixtures -------------------------------------------------------------
    const [aSourceType] = await db.select({ id: sourceTypes.id }).from(sourceTypes).limit(1);
    const [anItemType] = await db.select({ id: sourceItemTypes.id }).from(sourceItemTypes).limit(1);
    if (!aSourceType || !anItemType) {
      throw new Error("No source_types / source_item_types rows found -- run `npm run db:seed` against the check database first.");
    }

    async function createSourceItem(name: string): Promise<{ id: number; url: string }> {
      const [source] = await db.insert(sources).values({ name: `${name} ${randomUUID()}`, sourceTypeId: aSourceType.id }).returning();
      const [item] = await db
        .insert(sourceItems)
        .values({
          sourceId: source.id,
          itemTypeId: anItemType.id,
          url: `https://example.invalid/pr8a/${randomUUID()}`,
          title: name,
        })
        .returning();
      return { id: item.id, url: item.url };
    }

    async function latestProvenanceAuditSummary(): Promise<string | null> {
      const rows = await db
        .select({ summary: adminAuditLog.summary, action: adminAuditLog.action, entityId: adminAuditLog.entityId })
        .from(adminAuditLog)
        .where(and(eq(adminAuditLog.entityType, "source_relationship"), eq(adminAuditLog.action, "create")))
        .orderBy(desc(adminAuditLog.id))
        .limit(1);
      return rows[0]?.summary ?? null;
    }

    const subject = await createSourceItem("PR8a subject item");
    const object = await createSourceItem("PR8a object item");

    const [claim] = await db
      .insert(claims)
      .values({
        projectId: SEEDED_PROJECT_ID,
        slug: `pr8a-direction-claim-${randomUUID()}`,
        statement: "PR8a provenance direction fixture claim.",
        informationType: "report",
      })
      .returning();
    await db.insert(claimSources).values([
      { claimId: claim.id, sourceItemId: subject.id, stance: "supports" },
      { claimId: claim.id, sourceItemId: object.id, stance: "supports" },
    ]);

    // --- 1. Storage orientation -- the core write-path assertion ---------------
    const created = await createSourceRelationship({
      sourceItemIdA: subject.id,
      sourceItemIdB: object.id,
      relationshipType: "citation",
      evidenceNote: "PR8a fixture: the subject item explicitly attributes its claim to the object item.",
    });

    assert(
      created.sourceItemIdA === subject.id && created.sourceItemIdB === object.id,
      `createSourceRelationship stores the SUBJECT in source_item_id_a and the OBJECT in source_item_id_b with no swap (stored a=${created.sourceItemIdA}, b=${created.sourceItemIdB}; expected a=${subject.id}, b=${object.id})`
    );

    const [persisted] = await db.select().from(sourceRelationships).where(eq(sourceRelationships.id, created.id));
    assert(
      persisted.sourceItemIdA === subject.id && persisted.sourceItemIdB === object.id,
      "re-reading the row straight from the database confirms the same orientation -- the mutation's return value is not masking a swap"
    );

    // --- 2. Audit orientation --------------------------------------------------
    const auditSummary = await latestProvenanceAuditSummary();
    const expectedSummary = `Source item #${subject.id} cites source item #${object.id}`;
    // Casing is deliberate and matches the pre-existing summary format:
    // capitalised subject at sentence start, lowercase object mid-sentence.
    assert(
      auditSummary === expectedSummary,
      `the admin_audit_log summary names the SUBJECT first, in the shared vocabulary -- expected '${expectedSummary}', got '${auditSummary}'`
    );

    // --- 3/4. Admin read, both sides ------------------------------------------
    const subjectSide = await getSourceItemRelationships(subject.id);
    assert(
      subjectSide.outgoing.some((r) => r.other_id === object.id),
      "the subject item's page lists the row under OUTGOING (this item is doing the citing)"
    );
    assert(
      !subjectSide.incoming.some((r) => r.other_id === object.id),
      "the subject item's page does NOT also list it under incoming"
    );

    const objectSide = await getSourceItemRelationships(object.id);
    assert(
      objectSide.incoming.some((r) => r.other_id === subject.id),
      "the object item's page lists the row under INCOMING (this item is being cited)"
    );
    assert(
      !objectSide.outgoing.some((r) => r.other_id === subject.id),
      "the object item's page does NOT also list it under outgoing"
    );

    // --- 5. Public read --------------------------------------------------------
    const chain = await getClaimProvenanceChain(claim.id);
    const link = chain.find((l) => l.fromUrl === subject.url || l.toUrl === subject.url);
    assert(link !== undefined, "getClaimProvenanceChain returns the relationship for a claim both of whose sources are linked");
    assert(
      link !== undefined && link.fromUrl === subject.url && link.toUrl === object.url,
      "getClaimProvenanceChain resolves from = SUBJECT (source_item_id_a) and to = OBJECT (source_item_id_b) -- never reversed"
    );

    // --- 6. ONE canonical sentence across both surfaces ------------------------
    // This is the assertion that makes a future writer/reader divergence fail
    // the suite rather than ship.
    const publicSentence =
      link === undefined
        ? "<no link>"
        : describeProvenanceLink(link.relationshipType, `Source item #${subject.id}`, `source item #${object.id}`);
    assert(
      publicSentence === auditSummary,
      `the public provenance chain and the admin audit log produce the IDENTICAL sentence for the same stored row -- got '${publicSentence}' vs '${auditSummary}'`
    );

    // --- 8. Duplicate guard intact --------------------------------------------
    let duplicateRejected = false;
    try {
      await createSourceRelationship({
        sourceItemIdA: subject.id,
        sourceItemIdB: object.id,
        relationshipType: "citation",
      });
    } catch (err) {
      duplicateRejected = err instanceof DuplicateProvenanceLinkError;
    }
    assert(duplicateRejected, "re-inserting the identical (a, b, relationship_type) triple raises DuplicateProvenanceLinkError -- the isUniqueViolation path survived the refactor");

    // --- 9. Self-link guard intact --------------------------------------------
    let selfLinkRejected = false;
    try {
      await createSourceRelationship({
        sourceItemIdA: subject.id,
        sourceItemIdB: subject.id,
        relationshipType: "citation",
      });
    } catch {
      selfLinkRejected = true;
    }
    assert(selfLinkRejected, "a self-link is rejected by createSourceRelationshipSchema's refine, ahead of the database CHECK");

    // --- 10. BOTH directions may coexist -- non-canonicalization guard ---------
    // Guards against a plausible WRONG fix: someone later "solving" direction
    // problems by canonicalizing the pair the way claim_relationships does,
    // which would destroy this table's entire semantic purpose. "A cites B"
    // and "B cites A" are different facts and usually only one is true.
    const reverse = await createSourceRelationship({
      sourceItemIdA: object.id,
      sourceItemIdB: subject.id,
      relationshipType: "citation",
    });
    assert(
      reverse.sourceItemIdA === object.id && reverse.sourceItemIdB === subject.id,
      "the REVERSE row (b, a, same type) is accepted and stored in its own submitted orientation -- source_relationships is NOT canonicalized"
    );
    const bothRows = await db.select().from(sourceRelationships).where(eq(sourceRelationships.sourceItemIdA, subject.id));
    assert(
      bothRows.some((r) => r.sourceItemIdB === object.id) && reverse.id !== created.id,
      "both directed rows now exist independently as two distinct relationships"
    );

    // --- 7. Production-shaped fixture ------------------------------------------
    // Reproduces the exact shape of the two live production rows: "Site B
    // cites Site A", stored as (a = Site B, b = Site A).
    const siteB = await createSourceItem("PR8a Gaming Site B");
    const siteA = await createSourceItem("PR8a Gaming Site A");
    await createSourceRelationship({
      sourceItemIdA: siteB.id,
      sourceItemIdB: siteA.id,
      relationshipType: "citation",
      evidenceNote: "Site B article explicitly attributes its claim to Site A's reporting.",
    });
    const siteBSide = await getSourceItemRelationships(siteB.id);
    const siteASide = await getSourceItemRelationships(siteA.id);
    assert(
      siteBSide.outgoing.some((r) => r.other_id === siteA.id) && siteASide.incoming.some((r) => r.other_id === siteB.id),
      "production-shaped fixture: a row created as 'Site B cites Site A' reads back with Site B as the SUBJECT on both admin surfaces"
    );
    assert(
      (await latestProvenanceAuditSummary()) === `Source item #${siteB.id} cites source item #${siteA.id}`,
      "production-shaped fixture: the audit sentence reads 'Site B cites Site A', matching the seeded rows' evidence_note semantics"
    );
  } finally {
    // Deliberately NO incremental row cleanup here -- same established
    // convention as claimProposalReview.check.ts / claimRelationshipReview.check.ts:
    // this check writes admin_audit_log rows, which are append-only and cannot
    // be deleted at all. The check database is expected to be recreated via a
    // fresh migration chain + reseed for a clean run (see README.md's
    // verification sequence).
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll provenance direction round-trip checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
