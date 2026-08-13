import "server-only";
import { and, eq, or } from "drizzle-orm";
import { claimRelationships, claims } from "@/db/schema";
import { adminDb } from "@/db/adminClient";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
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


export async function createClaimRelationship(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createClaimRelationshipSchema.parse(input);

  const [claimIdA, claimIdB] = canonicalizeClaimRelationshipPair(
    data.claimIdA,
    data.claimIdB,
    data.relationshipType
  );

  try {
    return await withAuditedTransaction(async (tx) => {
      const [row] = await tx
        .insert(claimRelationships)
        .values({
          claimIdA,
          claimIdB,
          relationshipType: data.relationshipType,
          confidence: data.confidence?.toString(),
          createdBy: "human",
        })
        .returning();

      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "claim_relationship",
        entityId: row.id,
        summary: `Linked claim #${claimIdA} (${data.relationshipType}) claim #${claimIdB}`,
        metadata: { claimIdA, claimIdB, relationshipType: data.relationshipType },
      });

      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateRelationshipError();
    throw err;
  }
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
