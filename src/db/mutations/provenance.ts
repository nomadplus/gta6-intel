import "server-only";
import { eq } from "drizzle-orm";
import { sourceRelationships } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
import { createSourceRelationshipSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export class DuplicateProvenanceLinkError extends Error {
  constructor() {
    super("This exact provenance relationship already exists.");
    this.name = "DuplicateProvenanceLinkError";
  }
}


/**
 * Provenance relationships (citation, derivative, repetition, original,
 * independent_corroboration, aggregation, unknown) are NEVER
 * canonicalized -- "B cites A" and "A cites B" are different, and
 * frequently only one of them is even true. Stored exactly as submitted.
 */
export async function createSourceRelationship(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createSourceRelationshipSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [row] = await tx
        .insert(sourceRelationships)
        .values({
          sourceItemIdA: data.sourceItemIdA,
          sourceItemIdB: data.sourceItemIdB,
          relationshipType: data.relationshipType,
          confidence: data.confidence?.toString(),
          evidenceNote: data.evidenceNote,
        })
        .returning();

      await logAdminAction(tx, admin, {
        action: "create",
        entityType: "source_relationship",
        entityId: row.id,
        summary: `Source item #${data.sourceItemIdB} ${data.relationshipType} source item #${data.sourceItemIdA}`,
      });

      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateProvenanceLinkError();
    throw err;
  }
}

export async function deleteSourceRelationship(relationshipId: number) {
  const admin = await requireAdmin("editor");
  const id = z.coerce.number().int().positive().parse(relationshipId);

  return withAuditedTransaction(async (tx) => {
    const [deleted] = await tx.delete(sourceRelationships).where(eq(sourceRelationships.id, id)).returning();
    if (deleted) {
      await logAdminAction(tx, admin, {
        action: "unlink",
        entityType: "source_relationship",
        entityId: id,
        summary: `Removed provenance relationship #${id}`,
      });
    }
    return deleted;
  });
}
