import "server-only";
import { eq } from "drizzle-orm";
import { claimSources } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, isUniqueViolation } from "./shared";
import { linkClaimSourceSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export class DuplicateClaimSourceLinkError extends Error {
  constructor() {
    super("This source item is already linked to this claim.");
    this.name = "DuplicateClaimSourceLinkError";
  }
}


export async function linkClaimSource(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = linkClaimSourceSchema.parse(input);

  try {
    return await withAuditedTransaction(async (tx) => {
      const [link] = await tx
        .insert(claimSources)
        .values({
          claimId: data.claimId,
          sourceItemId: data.sourceItemId,
          stance: data.stance,
          supportingExcerpt: data.supportingExcerpt,
        })
        .returning();

      await logAdminAction(tx, admin, {
        action: "link",
        entityType: "claim_source",
        entityId: link.id,
        summary: `Linked source item #${data.sourceItemId} to claim #${data.claimId} (${data.stance})`,
      });

      return link;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateClaimSourceLinkError();
    throw err;
  }
}

export async function unlinkClaimSource(linkId: number) {
  const admin = await requireAdmin("editor");
  const id = z.coerce.number().int().positive().parse(linkId);

  return withAuditedTransaction(async (tx) => {
    const [deleted] = await tx.delete(claimSources).where(eq(claimSources.id, id)).returning();
    if (deleted) {
      await logAdminAction(tx, admin, {
        action: "unlink",
        entityType: "claim_source",
        entityId: id,
        summary: `Unlinked source item #${deleted.sourceItemId} from claim #${deleted.claimId}`,
      });
    }
    return deleted;
  });
}
