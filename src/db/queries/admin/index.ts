import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import {
  claims,
  sources,
  sourceItems,
  sourceTypes,
  sourceItemTypes,
  evidence,
  claimEvidence,
  topics,
  claimTopics,
  adminAuditLog,
  adminUsers,
  aiResults,
  adminDecisions,
  aiJobs,
  ingestionJobs,
  discoveryProviders,
} from "@/db/schema";

export async function listClaimsForAdmin() {
  return adminDb
    .select({
      id: claims.id,
      slug: claims.slug,
      statement: claims.statement,
      informationType: claims.informationType,
      currentInvestigationStatus: claims.currentInvestigationStatus,
      currentDevelopmentOutcome: claims.currentDevelopmentOutcome,
      createdAt: claims.createdAt,
    })
    .from(claims)
    .orderBy(desc(claims.createdAt));
}

export async function getClaimForAdmin(id: number) {
  const rows = await adminDb.select().from(claims).where(eq(claims.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listSourcesForAdmin() {
  return adminDb
    .select({
      id: sources.id,
      name: sources.name,
      sourceTypeLabel: sourceTypes.label,
      homepageUrl: sources.homepageUrl,
    })
    .from(sources)
    .innerJoin(sourceTypes, eq(sourceTypes.id, sources.sourceTypeId))
    .orderBy(sources.name);
}

export async function getSourceForAdmin(id: number) {
  const rows = await adminDb.select().from(sources).where(eq(sources.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listSourceItemsForAdmin() {
  return adminDb
    .select({
      id: sourceItems.id,
      title: sourceItems.title,
      url: sourceItems.url,
      itemTypeLabel: sourceItemTypes.label,
      sourceName: sources.name,
      publishedAt: sourceItems.publishedAt,
    })
    .from(sourceItems)
    .innerJoin(sourceItemTypes, eq(sourceItemTypes.id, sourceItems.itemTypeId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .orderBy(desc(sourceItems.retrievedAt));
}

export async function getSourceItemForAdmin(id: number) {
  const rows = await adminDb.select().from(sourceItems).where(eq(sourceItems.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Ingestion job history/queue (Phase 4 PR 6) — read-only observability
 * over `ingestion_jobs`. `discoveryProviders` is an inner join (the FK is
 * NOT NULL); `adminUsers` and `sourceItems` are left joins since a job can
 * predate an admin link or never resolve to a stored item (most
 * `needs_review`/failure outcomes never do).
 */
const ingestionJobListSelection = {
  id: ingestionJobs.id,
  submittedUrl: ingestionJobs.submittedUrl,
  normalizedUrl: ingestionJobs.normalizedUrl,
  status: ingestionJobs.status,
  discoveryProviderLabel: discoveryProviders.label,
  initiatedBy: ingestionJobs.initiatedBy,
  adminDisplayName: adminUsers.displayName,
  httpStatus: ingestionJobs.httpStatus,
  contentType: ingestionJobs.contentType,
  contentLength: ingestionJobs.contentLength,
  attemptCount: ingestionJobs.attemptCount,
  startedAt: ingestionJobs.startedAt,
  nextRetryAt: ingestionJobs.nextRetryAt,
  failureReason: ingestionJobs.failureReason,
  sourceItemId: ingestionJobs.sourceItemId,
  sourceItemTitle: sourceItems.title,
  sourceItemUrl: sourceItems.url,
  createdAt: ingestionJobs.createdAt,
  completedAt: ingestionJobs.completedAt,
} as const;

export async function listIngestionJobsForAdmin() {
  return adminDb
    .select(ingestionJobListSelection)
    .from(ingestionJobs)
    .innerJoin(discoveryProviders, eq(discoveryProviders.id, ingestionJobs.discoveryProviderId))
    .leftJoin(adminUsers, eq(adminUsers.id, ingestionJobs.adminUserId))
    .leftJoin(sourceItems, eq(sourceItems.id, ingestionJobs.sourceItemId))
    .orderBy(desc(ingestionJobs.createdAt));
}

export async function getIngestionJobForAdmin(id: number) {
  const rows = await adminDb
    .select(ingestionJobListSelection)
    .from(ingestionJobs)
    .innerJoin(discoveryProviders, eq(discoveryProviders.id, ingestionJobs.discoveryProviderId))
    .leftJoin(adminUsers, eq(adminUsers.id, ingestionJobs.adminUserId))
    .leftJoin(sourceItems, eq(sourceItems.id, ingestionJobs.sourceItemId))
    .where(eq(ingestionJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listEvidenceForAdmin() {
  const rows = await adminDb
    .select({
      id: evidence.id,
      description: evidence.description,
      evidenceType: evidence.evidenceType,
      linkedClaimCount: sql<number>`count(${claimEvidence.id})::int`,
    })
    .from(evidence)
    .leftJoin(claimEvidence, eq(claimEvidence.evidenceId, evidence.id))
    .groupBy(evidence.id, evidence.description, evidence.evidenceType)
    .orderBy(desc(evidence.id));
  return rows;
}

export async function getEvidenceForAdmin(id: number) {
  const rows = await adminDb.select().from(evidence).where(eq(evidence.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listTopicsForAdmin() {
  const rows = await adminDb
    .select({
      id: topics.id,
      slug: topics.slug,
      name: topics.name,
      description: topics.description,
      claimCount: sql<number>`count(${claimTopics.id})::int`,
    })
    .from(topics)
    .leftJoin(claimTopics, eq(claimTopics.topicId, topics.id))
    .groupBy(topics.id, topics.slug, topics.name, topics.description)
    .orderBy(topics.name);
  return rows;
}

export async function listSourceTypeOptions() {
  return adminDb.select({ id: sourceTypes.id, label: sourceTypes.label }).from(sourceTypes).orderBy(sourceTypes.label);
}

export async function listSourceItemTypeOptions() {
  return adminDb
    .select({ id: sourceItemTypes.id, label: sourceItemTypes.label })
    .from(sourceItemTypes)
    .orderBy(sourceItemTypes.label);
}

/** Recent admin activity for the dashboard — reads the append-only audit log. */
export async function getRecentAdminActivity(limit = 20) {
  return adminDb
    .select({
      id: adminAuditLog.id,
      action: adminAuditLog.action,
      entityType: adminAuditLog.entityType,
      entityId: adminAuditLog.entityId,
      summary: adminAuditLog.summary,
      createdAt: adminAuditLog.createdAt,
      adminName: adminUsers.displayName,
    })
    .from(adminAuditLog)
    .innerJoin(adminUsers, eq(adminUsers.id, adminAuditLog.adminUserId))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);
}

/** Read-only view of existing AI/admin audit records — Section 3's /admin/review. */
export async function listAiReviewRecords(limit = 50) {
  return adminDb
    .select({
      aiResultId: aiResults.id,
      claimId: aiResults.claimId,
      confidence: aiResults.confidence,
      reasoning: aiResults.reasoning,
      createdAt: aiResults.createdAt,
      provider: aiJobs.provider,
      model: aiJobs.model,
      operation: aiJobs.operation,
      decisionAction: adminDecisions.action,
      decisionNotes: adminDecisions.notes,
      decidedAt: adminDecisions.decidedAt,
    })
    .from(aiResults)
    .innerJoin(aiJobs, eq(aiJobs.id, aiResults.aiJobId))
    .leftJoin(adminDecisions, eq(adminDecisions.aiResultId, aiResults.id))
    .orderBy(desc(aiResults.createdAt))
    .limit(limit);
}

export async function getSourceItemRelationships(sourceItemId: number) {
  const outgoing = await adminDb.execute<{
    id: number;
    relationship_type: string;
    confidence: string | null;
    evidence_note: string | null;
    other_id: number;
    other_title: string | null;
    other_url: string;
  }>(sql`
    SELECT sr.id, sr.relationship_type, sr.confidence, sr.evidence_note,
           b.id AS other_id, b.title AS other_title, b.url AS other_url
    FROM source_relationships sr
    JOIN source_items b ON b.id = sr.source_item_id_b
    WHERE sr.source_item_id_a = ${sourceItemId}
    ORDER BY sr.id
  `);
  const incoming = await adminDb.execute<{
    id: number;
    relationship_type: string;
    confidence: string | null;
    evidence_note: string | null;
    other_id: number;
    other_title: string | null;
    other_url: string;
  }>(sql`
    SELECT sr.id, sr.relationship_type, sr.confidence, sr.evidence_note,
           a.id AS other_id, a.title AS other_title, a.url AS other_url
    FROM source_relationships sr
    JOIN source_items a ON a.id = sr.source_item_id_a
    WHERE sr.source_item_id_b = ${sourceItemId}
    ORDER BY sr.id
  `);
  return {
    outgoing: outgoing.rows.map((r) => ({ ...r, direction: "outgoing" as const })),
    incoming: incoming.rows.map((r) => ({ ...r, direction: "incoming" as const })),
  };
}

export async function getEvidenceClaimLinks(evidenceId: number) {
  return adminDb
    .select({
      linkId: claimEvidence.id,
      claimId: claims.id,
      statement: claims.statement,
      stance: claimEvidence.stance,
    })
    .from(claimEvidence)
    .innerJoin(claims, eq(claims.id, claimEvidence.claimId))
    .where(eq(claimEvidence.evidenceId, evidenceId));
}

export async function getDashboardStats() {
  const result = await adminDb.execute<{
    total_claims: number;
    by_investigation: Record<string, number>;
    by_outcome: Record<string, number>;
    total_sources: number;
    total_source_items: number;
    total_evidence: number;
    unresolved_claims: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM claims)::int AS total_claims,
      (SELECT jsonb_object_agg(current_investigation_status, cnt) FROM (
        SELECT current_investigation_status, count(*) AS cnt FROM claims GROUP BY current_investigation_status
      ) s) AS by_investigation,
      (SELECT jsonb_object_agg(current_development_outcome, cnt) FROM (
        SELECT current_development_outcome, count(*) AS cnt FROM claims GROUP BY current_development_outcome
      ) s) AS by_outcome,
      (SELECT count(*) FROM sources)::int AS total_sources,
      (SELECT count(*) FROM source_items)::int AS total_source_items,
      (SELECT count(*) FROM evidence)::int AS total_evidence,
      (SELECT count(*) FROM claims WHERE current_investigation_status IN ('unverified','corroborated','strongly_corroborated'))::int AS unresolved_claims
  `);
  return result.rows[0];
}
