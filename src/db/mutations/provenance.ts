import "server-only";
import { eq } from "drizzle-orm";
import { sourceRelationships } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
import { createSourceRelationshipSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { describeProvenanceLink } from "@/lib/provenanceDirection";
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
 *
 * Phase 5 PR 8a: direction is `sourceItemIdA` = SUBJECT, `sourceItemIdB` =
 * OBJECT. See src/lib/provenanceDirection.ts for the canonical statement of
 * that invariant and for the write-direction defect this convention closed.
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
        // Phase 5 PR 8a: SUBJECT FIRST. This previously read
        // "#{sourceItemIdB} {type} #{sourceItemIdA}", which was self-consistent
        // with the old (inverted) form binding but described the OPPOSITE of
        // the row actually stored. Composed via describeProvenanceLink so this
        // sentence and the public provenance chain's sentence are produced by
        // the same vocabulary for the same row.
        summary: describeProvenanceLink(
          data.relationshipType,
          `Source item #${data.sourceItemIdA}`,
          // Lowercase mid-sentence, preserving the original summary's casing.
          `source item #${data.sourceItemIdB}`
        ),
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
