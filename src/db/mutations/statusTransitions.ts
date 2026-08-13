import "server-only";
import { eq, sql } from "drizzle-orm";
import {
  claims,
  claimInvestigationStatusHistory,
  claimDevelopmentOutcomeHistory,
  investigationTransitionEvidence,
  developmentTransitionEvidence,
  adminDecisions,
} from "@/db/schema";
import { withAuditedTransaction, logAdminAction } from "./shared";
import { investigationTransitionSchema, developmentTransitionSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";

/**
 * Changes a claim's Investigation Status. This NEVER performs an UPDATE
 * on claims.current_investigation_status directly -- it inserts a new
 * row into the append-only claim_investigation_status_history ledger,
 * and the Phase 1 trigger (sync_current_investigation_status) is what
 * updates the denormalized pointer. The admin UI has no code path that
 * could bypass the ledger even if it tried, because there is no mutation
 * function that writes to that column.
 */
export async function transitionInvestigationStatus(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = investigationTransitionSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [current] = await tx
      .select({ status: claims.currentInvestigationStatus, statement: claims.statement })
      .from(claims)
      .where(eq(claims.id, data.claimId))
      .for("update");

    if (!current) throw new Error(`Claim #${data.claimId} not found`);

    const [decision] = await tx
      .insert(adminDecisions)
      .values({
        aiResultId: null,
        adminUserId: admin.id,
        action: "direct_change",
        notes: data.reason,
      })
      .returning();

    const [historyRow] = await tx
      .insert(claimInvestigationStatusHistory)
      .values({
        claimId: data.claimId,
        previousStatus: current.status,
        newStatus: data.newStatus,
        reason: data.reason,
        confidence: data.confidence?.toString(),
        initiatedBy: "human",
        adminDecisionId: decision.id,
      })
      .returning();

    for (const evidenceId of data.evidenceIds) {
      await tx.insert(investigationTransitionEvidence).values({
        transitionId: historyRow.id,
        evidenceId,
      });
    }

    await logAdminAction(tx, admin, {
      action: "transition",
      entityType: "investigation_status_history",
      entityId: historyRow.id,
      summary: `Claim #${data.claimId} investigation status: ${current.status} → ${data.newStatus}`,
      metadata: { claimId: data.claimId, previousStatus: current.status, newStatus: data.newStatus },
    });

    return historyRow;
  });
}

/** Same pattern as transitionInvestigationStatus, for the other axis. */
export async function transitionDevelopmentOutcome(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = developmentTransitionSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [current] = await tx
      .select({ outcome: claims.currentDevelopmentOutcome })
      .from(claims)
      .where(eq(claims.id, data.claimId))
      .for("update");

    if (!current) throw new Error(`Claim #${data.claimId} not found`);

    const [decision] = await tx
      .insert(adminDecisions)
      .values({
        aiResultId: null,
        adminUserId: admin.id,
        action: "direct_change",
        notes: data.reason,
      })
      .returning();

    const [historyRow] = await tx
      .insert(claimDevelopmentOutcomeHistory)
      .values({
        claimId: data.claimId,
        previousOutcome: current.outcome,
        newOutcome: data.newOutcome,
        reason: data.reason,
        confidence: data.confidence?.toString(),
        initiatedBy: "human",
        adminDecisionId: decision.id,
      })
      .returning();

    for (const evidenceId of data.evidenceIds) {
      await tx.insert(developmentTransitionEvidence).values({
        transitionId: historyRow.id,
        evidenceId,
      });
    }

    await logAdminAction(tx, admin, {
      action: "transition",
      entityType: "development_outcome_history",
      entityId: historyRow.id,
      summary: `Claim #${data.claimId} development outcome: ${current.outcome} → ${data.newOutcome}`,
      metadata: { claimId: data.claimId, previousOutcome: current.outcome, newOutcome: data.newOutcome },
    });

    return historyRow;
  });
}
