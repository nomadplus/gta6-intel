import "server-only";
import { and, eq } from "drizzle-orm";
import { claimSources, type claimSourceStanceEnum } from "@/db/schema";
import { withAuditedTransaction, logAdminAction, type DbTransaction } from "./shared";
import { linkClaimSourceSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { z } from "zod";

export class DuplicateClaimSourceLinkError extends Error {
  constructor() {
    super("This source item is already linked to this claim.");
    this.name = "DuplicateClaimSourceLinkError";
  }
}

export interface NewClaimSourceLink {
  claimId: number;
  sourceItemId: number;
  stance: (typeof claimSourceStanceEnum.enumValues)[number];
  supportingExcerpt: string | null;
}

export type ClaimSourceLinkRow = typeof claimSources.$inferSelect;

/**
 * Phase 5 PR 6: the transaction-scoped write primitive both linkClaimSource
 * below AND resolveProposalAsExistingClaim (claimProposalReviews.ts) use --
 * ONE implementation of "insert a claim_sources row, or recognize the pair
 * already has one," not two. Deliberately typed to accept ONLY a
 * DbTransaction, never bare adminDb -- this exists specifically so the
 * insert participates in whatever larger atomic transaction its caller is
 * already running, and the type system (not a comment) is what prevents a
 * future caller from using it outside one.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING rather than catching a unique-
 * violation exception -- deliberately: a caught exception mid-transaction
 * would poison the whole Postgres transaction (any statement after a
 * failed one in the same transaction errors with "current transaction is
 * aborted" until rollback), which would break a caller like
 * resolveProposalAsExistingClaim that still has more writes to make in the
 * SAME transaction after this one. ON CONFLICT DO NOTHING never raises,
 * so composition is safe.
 *
 * claim_sources_unique (migration 0000) is on (claim_id, source_item_id)
 * ONLY -- it does not include stance -- so at most one row can ever exist
 * for a given (claim, source item) pair, and this function correctly
 * treats "a row already exists" as idempotent success, never overwriting
 * that row's existing stance/supportingExcerpt.
 */
export async function insertClaimSourceLinkTx(
  tx: DbTransaction,
  data: NewClaimSourceLink
): Promise<{ link: ClaimSourceLinkRow; wasNewLink: boolean }> {
  const [inserted] = await tx
    .insert(claimSources)
    .values(data)
    .onConflictDoNothing({ target: [claimSources.claimId, claimSources.sourceItemId] })
    .returning();

  if (inserted) return { link: inserted, wasNewLink: true };

  const [existing] = await tx
    .select()
    .from(claimSources)
    .where(and(eq(claimSources.claimId, data.claimId), eq(claimSources.sourceItemId, data.sourceItemId)))
    .limit(1);

  // Under READ COMMITTED, a transaction that just observed ON CONFLICT DO
  // NOTHING skip a row must be able to see that same already-committed
  // conflicting row on an immediate re-select -- this branch should be
  // unreachable. It exists so a genuine violation of that assumption
  // aborts the transaction with an explicit, loud error rather than this
  // function returning an invalid result under a non-null return type.
  if (!existing) {
    throw new Error(
      `insertClaimSourceLinkTx invariant violation: ON CONFLICT DO NOTHING reported an existing row for ` +
        `(claimId=${data.claimId}, sourceItemId=${data.sourceItemId}), but no row was found on immediate re-select.`
    );
  }

  return { link: existing, wasNewLink: false };
}

export async function linkClaimSource(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = linkClaimSourceSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const { link, wasNewLink } = await insertClaimSourceLinkTx(tx, {
      claimId: data.claimId,
      sourceItemId: data.sourceItemId,
      stance: data.stance,
      supportingExcerpt: data.supportingExcerpt ?? null,
    });

    // This entry point means "an admin explicitly asked to create this
    // link" -- unlike resolveProposalAsExistingClaim's idempotent
    // treatment of the same primitive, an already-existing link here IS
    // the error case this function has always reported.
    if (!wasNewLink) throw new DuplicateClaimSourceLinkError();

    await logAdminAction(tx, admin, {
      action: "link",
      entityType: "claim_source",
      entityId: link.id,
      summary: `Linked source item #${data.sourceItemId} to claim #${data.claimId} (${data.stance})`,
    });

    return link;
  });
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
