import "server-only";
import { eq } from "drizzle-orm";
import { evidence, claimEvidence } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
import { createEvidenceSchema, linkEvidenceToClaimSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export class DuplicateEvidenceLinkError extends Error {
  constructor() {
    super("This evidence is already linked to this claim.");
    this.name = "DuplicateEvidenceLinkError";
  }
}


/**
 * Creates a standalone evidence record. No claim link is required or
 * even accepted here -- evidence can and often will exist unlinked,
 * pending later review (Phase 1 design). Use linkEvidenceToClaim
 * separately, zero or more times, once a match is confirmed.
 */
export async function createEvidence(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createEvidenceSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [row] = await tx
      .insert(evidence)
      .values({
        description: data.description,
        evidenceType: data.evidenceType,
        sourceItemId: data.sourceItemId,
        addedBy: "human",
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "evidence",
      entityId: row.id,
      summary: `Created evidence #${row.id}`,
    });

    return row;
  });
}

export async function linkEvidenceToClaim(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = linkEvidenceToClaimSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [link] = await tx
        .insert(claimEvidence)
        .values({ claimId: data.claimId, evidenceId: data.evidenceId, stance: data.stance })
        .returning();

      await logAdminAction(tx, admin, {
        action: "link",
        entityType: "claim_evidence",
        entityId: link.id,
        summary: `Linked evidence #${data.evidenceId} to claim #${data.claimId} (${data.stance})`,
      });

      return link;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateEvidenceLinkError();
    throw err;
  }
}

/** Unlinks evidence from a claim without deleting the evidence entity itself. */
export async function unlinkEvidenceFromClaim(linkId: number) {
  const admin = await requireAdmin("editor");
  const id = z.coerce.number().int().positive().parse(linkId);

  return withAuditedTransaction(async (tx) => {
    const [deleted] = await tx.delete(claimEvidence).where(eq(claimEvidence.id, id)).returning();
    if (deleted) {
      await logAdminAction(tx, admin, {
        action: "unlink",
        entityType: "claim_evidence",
        entityId: id,
        summary: `Unlinked evidence #${deleted.evidenceId} from claim #${deleted.claimId}`,
      });
    }
    return deleted;
  });
}
