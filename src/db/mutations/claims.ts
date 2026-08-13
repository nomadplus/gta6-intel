import "server-only";
import { eq } from "drizzle-orm";
import { claims, claimTopics, claimInvestigationStatusHistory, claimDevelopmentOutcomeHistory, adminDecisions } from "@/db/schema";
import { withAuditedTransaction, logAdminAction } from "./shared";
import { createClaimSchema, updateClaimMetadataSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";

/**
 * Creates a claim plus its initial status on both axes. The initial
 * status still goes through the same append-only ledgers as any later
 * transition (previous_status = null, initiated_by = 'human') -- there
 * is no separate "just set the field" path even for a brand-new claim.
 */
export async function createClaim(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createClaimSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [claim] = await tx
      .insert(claims)
      .values({
        projectId: data.projectId,
        statement: data.statement,
        slug: data.slug,
        informationType: data.informationType,
        firstReportedAt: data.firstReportedAt,
      })
      .returning();

    for (const topicId of data.topicIds) {
      await tx.insert(claimTopics).values({ claimId: claim.id, topicId });
    }

    const [invDecision] = await tx
      .insert(adminDecisions)
      .values({ adminUserId: admin.id, action: "direct_change", notes: `Initial status on creation: ${data.reason}` })
      .returning();
    await tx.insert(claimInvestigationStatusHistory).values({
      claimId: claim.id,
      previousStatus: null,
      newStatus: data.initialInvestigationStatus,
      reason: data.reason,
      initiatedBy: "human",
      adminDecisionId: invDecision.id,
    });

    const [devDecision] = await tx
      .insert(adminDecisions)
      .values({ adminUserId: admin.id, action: "direct_change", notes: `Initial status on creation: ${data.reason}` })
      .returning();
    await tx.insert(claimDevelopmentOutcomeHistory).values({
      claimId: claim.id,
      previousOutcome: null,
      newOutcome: data.initialDevelopmentOutcome,
      reason: data.reason,
      initiatedBy: "human",
      adminDecisionId: devDecision.id,
    });

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "claim",
      entityId: claim.id,
      summary: `Created claim #${claim.id}: "${data.statement.slice(0, 80)}${data.statement.length > 80 ? "…" : ""}"`,
    });

    return claim;
  });
}

/**
 * Metadata-only edit. There is deliberately no field here for either
 * status axis -- current_investigation_status and
 * current_development_outcome are never directly settable; see
 * statusTransitions.ts.
 */
export async function updateClaimMetadata(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = updateClaimMetadataSchema.parse(input);

  return withAuditedTransaction(async (tx) => {
    const [updated] = await tx
      .update(claims)
      .set({
        statement: data.statement,
        slug: data.slug,
        informationType: data.informationType,
        firstReportedAt: data.firstReportedAt,
      })
      .where(eq(claims.id, data.claimId))
      .returning();

    await tx.delete(claimTopics).where(eq(claimTopics.claimId, data.claimId));
    for (const topicId of data.topicIds) {
      await tx.insert(claimTopics).values({ claimId: data.claimId, topicId });
    }

    await logAdminAction(tx, admin, {
      action: "update",
      entityType: "claim",
      entityId: data.claimId,
      summary: `Updated metadata for claim #${data.claimId}`,
    });

    return updated;
  });
}
