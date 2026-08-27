import "server-only";
import { and, eq, or } from "drizzle-orm";
import { claimRelationships, claims, type claimRelationshipTypeEnum } from "@/db/schema";
import { adminDb } from "@/db/adminClient";
import { withAuditedTransaction, logAdminAction, isUniqueViolation, type DbTransaction } from "./shared";
import { createClaimRelationshipSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin, type AuthorizedAdmin } from "@/lib/auth/requireAdmin";
import { canonicalizeClaimRelationshipPair } from "@/lib/relationshipCanonicalization";
import { z } from "zod";

export class DuplicateRelationshipError extends Error {
  constructor() {
    super("This relationship (or its reverse, for symmetric types) already exists.");
    this.name = "DuplicateRelationshipError";
  }
}

export interface NewClaimRelationship {
  claimIdA: number;
  claimIdB: number;
  relationshipType: (typeof claimRelationshipTypeEnum.enumValues)[number];
  confidence?: number | null;
  createdBy: "ai" | "human" | "system";
}

export type ClaimRelationshipRow = typeof claimRelationships.$inferSelect;

/**
 * Phase 5 PR 7: the transaction-scoped write primitive both
 * createClaimRelationship below AND approveClaimComparison /
 * approveClaimComparisonWithChanges (claimComparisonReviews.ts) use --
 * ONE implementation of "insert a claim_relationships row, or recognize
 * the pair already has one," not two. Deliberately typed to accept ONLY
 * a DbTransaction, never bare adminDb -- same reasoning and shape as
 * insertClaimSourceLinkTx (claimSources.ts, Phase 5 PR 6): this exists
 * specifically so the insert participates in whatever larger atomic
 * transaction its caller is already running, and the type system (not a
 * comment) is what prevents a future caller from using it outside one.
 *
 * Applies canonicalizeClaimRelationshipPair() BEFORE the insert -- the
 * caller supplies claimIdA/claimIdB in whatever orientation it resolved
 * (e.g. focus/other after direction resolution), and this function is
 * what actually produces the EFFECTIVE, canonical stored orientation.
 * Callers that need the "as-approved" tuple for an immutable snapshot
 * (claimComparisonReviews.ts) must read it off THIS function's returned
 * row, never off their own pre-canonicalization values.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING rather than catching a unique-
 * violation exception -- deliberately, for the identical reason
 * insertClaimSourceLinkTx documents at length: a caught exception
 * mid-transaction would poison the whole Postgres transaction (any
 * statement after a failed one in the same transaction errors with
 * "current transaction is aborted" until rollback), which would break a
 * caller like approveClaimComparison that still has more writes to make
 * in the SAME transaction after this one. ON CONFLICT DO NOTHING never
 * raises, so composition is safe.
 *
 * claim_relationships_no_duplicate (migration 0000) is on (claim_id_a,
 * claim_id_b, relationship_type) -- so at most one row can ever exist for
 * a given (pair, type). This function correctly treats "a row already
 * exists" as idempotent success, never overwriting that row's existing
 * confidence/createdBy.
 */
export async function insertClaimRelationshipTx(
  tx: DbTransaction,
  data: NewClaimRelationship
): Promise<{ relationship: ClaimRelationshipRow; wasNewRelationship: boolean }> {
  const [claimIdA, claimIdB] = canonicalizeClaimRelationshipPair(data.claimIdA, data.claimIdB, data.relationshipType);

  const [inserted] = await tx
    .insert(claimRelationships)
    .values({
      claimIdA,
      claimIdB,
      relationshipType: data.relationshipType,
      confidence: data.confidence != null ? data.confidence.toString() : null,
      createdBy: data.createdBy,
    })
    .onConflictDoNothing({ target: [claimRelationships.claimIdA, claimRelationships.claimIdB, claimRelationships.relationshipType] })
    .returning();

  if (inserted) return { relationship: inserted, wasNewRelationship: true };

  const [existing] = await tx
    .select()
    .from(claimRelationships)
    .where(
      and(
        eq(claimRelationships.claimIdA, claimIdA),
        eq(claimRelationships.claimIdB, claimIdB),
        eq(claimRelationships.relationshipType, data.relationshipType)
      )
    )
    .limit(1);

  // Under READ COMMITTED, a transaction that just observed ON CONFLICT DO
  // NOTHING skip a row must be able to see that same already-committed
  // conflicting row on an immediate re-select -- this branch should be
  // unreachable. It exists so a genuine violation of that assumption
  // aborts the transaction with an explicit, loud error rather than this
  // function returning an invalid result under a non-null return type.
  if (!existing) {
    throw new Error(
      `insertClaimRelationshipTx invariant violation: ON CONFLICT DO NOTHING reported an existing row for ` +
        `(claimIdA=${claimIdA}, claimIdB=${claimIdB}, relationshipType=${data.relationshipType}), but no row was found on immediate re-select.`
    );
  }

  return { relationship: existing, wasNewRelationship: false };
}

export async function createClaimRelationship(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createClaimRelationshipSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const { relationship, wasNewRelationship } = await insertClaimRelationshipTx(tx, {
      claimIdA: data.claimIdA,
      claimIdB: data.claimIdB,
      relationshipType: data.relationshipType,
      confidence: data.confidence ?? null,
      createdBy: "human",
    });

    // This entry point means "an admin explicitly asked to create this
    // relationship" -- unlike the comparison-review approval flow's
    // idempotent treatment of the same primitive, an already-existing
    // relationship here IS the error case this function has always
    // reported. Public behavior of this function is unchanged by this
    // refactor: it still throws DuplicateRelationshipError, still inside
    // the same transaction, still via the same generic unique-violation
    // path (the ON CONFLICT DO NOTHING inside insertClaimRelationshipTx
    // never raises, so this check -- not a caught exception -- is what
    // preserves that behavior now).
    if (!wasNewRelationship) throw new DuplicateRelationshipError();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "claim_relationship",
      entityId: relationship.id,
      summary: `Linked claim #${relationship.claimIdA} (${data.relationshipType}) claim #${relationship.claimIdB}`,
      metadata: { claimIdA: relationship.claimIdA, claimIdB: relationship.claimIdB, relationshipType: data.relationshipType },
    });

    return relationship;
  });
}

export async function deleteClaimRelationship(relationshipId: number) {
  const admin = await requireAdmin("editor");
  const id = z.coerce.number().int().positive().parse(relationshipId);

  return withAuditedTransaction(async (tx) => {
    const [deleted] = await tx.delete(claimRelationships).where(eq(claimRelationships.id, id)).returning();
    if (deleted) {
      await logAdminAction(tx, admin, {
        action: "unlink",
        entityType: "claim_relationship",
        entityId: id,
        summary: `Removed relationship between claim #${deleted.claimIdA} and claim #${deleted.claimIdB}`,
      });
    }
    return deleted;
  });
}
