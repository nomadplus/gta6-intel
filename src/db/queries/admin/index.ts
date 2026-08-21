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
  discoveryFeeds,
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
  // Added in migration 0009 (Phase 4 PR 7) -- surfaced so the History detail
  // page can show what was extracted and, for a still-open needs_review job,
  // offer a re-signed confirm form via prepareHistoryReviewConfirmation
  // (db/mutations/ingestion.ts) rather than requiring these to be re-derived
  // from scratch here.
  retrievedUrl: ingestionJobs.retrievedUrl,
  canonicalUrl: ingestionJobs.canonicalUrl,
  rawContentHash: ingestionJobs.rawContentHash,
  extractedTitle: ingestionJobs.extractedTitle,
  extractedAuthor: ingestionJobs.extractedAuthor,
  extractedPublishedAt: ingestionJobs.extractedPublishedAt,
  extractedExcerpt: ingestionJobs.extractedExcerpt,
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

/**
 * Discovery feed configuration (Phase 4 PR 8) — read-only observability
 * over `discovery_feeds`. Inner join to `sources`, since sourceId is
 * NOT NULL (every feed must reference an existing source; no inline
 * source creation from this table). Nothing here is fetched or polled --
 * `lastPolledAt`/`lastPollStatus` remain null until PR 10's poller exists.
 */
export async function listDiscoveryFeedsForAdmin() {
  return adminDb
    .select({
      id: discoveryFeeds.id,
      feedUrl: discoveryFeeds.feedUrl,
      enabled: discoveryFeeds.enabled,
      pollingIntervalMinutes: discoveryFeeds.pollingIntervalMinutes,
      lastPolledAt: discoveryFeeds.lastPolledAt,
      lastPollStatus: discoveryFeeds.lastPollStatus,
      sourceId: sources.id,
      sourceName: sources.name,
      createdAt: discoveryFeeds.createdAt,
    })
    .from(discoveryFeeds)
    .innerJoin(sources, eq(sources.id, discoveryFeeds.sourceId))
    .orderBy(desc(discoveryFeeds.createdAt));
}

export async function getDiscoveryFeedForAdmin(id: number) {
  const rows = await adminDb
    .select({
      id: discoveryFeeds.id,
      feedUrl: discoveryFeeds.feedUrl,
      enabled: discoveryFeeds.enabled,
      pollingIntervalMinutes: discoveryFeeds.pollingIntervalMinutes,
      lastPolledAt: discoveryFeeds.lastPolledAt,
      lastPollStatus: discoveryFeeds.lastPollStatus,
      sourceId: sources.id,
      sourceName: sources.name,
      createdAt: discoveryFeeds.createdAt,
    })
    .from(discoveryFeeds)
    .innerJoin(sources, eq(sources.id, discoveryFeeds.sourceId))
    .where(eq(discoveryFeeds.id, id))
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

/**
 * Phase 5 PR 3: the minimal source-item shape classify_relevance needs.
 * Lives here (a plain read, alongside every other admin/AI-adjacent read
 * over source_items in this file) rather than in
 * src/db/mutations/ingestion.ts or classificationRecovery.ts -- neither
 * of those DB-mutation modules should know that AI classification exists
 * (Section 9/15).
 */
export async function getSourceItemForClassification(sourceItemId: number) {
  const rows = await adminDb
    .select({ id: sourceItems.id, url: sourceItems.url, title: sourceItems.title, excerpt: sourceItems.excerpt })
    .from(sourceItems)
    .where(eq(sourceItems.id, sourceItemId))
    .limit(1);
  return rows[0] ?? null;
}

export interface SourceItemClassificationStatusRow {
  sourceItemId: number;
  title: string | null;
  url: string;
  jobId: number | null;
  jobStatus: "pending" | "running" | "succeeded" | "failed" | null;
  jobError: string | null;
  jobCreatedAt: Date | null;
  jobStartedAt: Date | null;
  jobCompletedAt: Date | null;
  /** Only populated for a succeeded job -- parsed from ai_results.structured_output, since classify_relevance deliberately leaves ai_results.confidence/reasoning NULL (see classifyRelevance.ts's header comment). */
  relevance: "relevant" | "irrelevant" | "needs_review" | null;
  confidence: number | null;
  reasoning: string | null;
}

/**
 * The most recent classify_relevance ai_jobs row (if any) per source
 * item, via a LATERAL join -- Drizzle's query builder has no clean way
 * to express "top 1 row per group," so this is raw SQL, same convention
 * as getSourceItemRelationships/getDashboardStats above. Feeds
 * computeClassificationDisplayStatus (src/lib/ai/classificationRecoveryLifecycle.ts)
 * to render exactly one of unclassified / in_progress / stale / failed /
 * succeeded per item -- see that function's header for why a fresh
 * in-flight job must never collapse into "missing" or "failed".
 */
export async function listSourceItemClassificationStatus(limit = 50) {
  const result = await adminDb.execute<{
    source_item_id: number;
    title: string | null;
    url: string;
    job_id: number | null;
    job_status: "pending" | "running" | "succeeded" | "failed" | null;
    job_error: string | null;
    job_created_at: Date | null;
    job_started_at: Date | null;
    job_completed_at: Date | null;
    structured_output: unknown;
  }>(sql`
    SELECT
      si.id AS source_item_id,
      si.title,
      si.url,
      j.id AS job_id,
      j.status AS job_status,
      j.error AS job_error,
      j.created_at AS job_created_at,
      j.started_at AS job_started_at,
      j.completed_at AS job_completed_at,
      r.structured_output AS structured_output
    FROM source_items si
    LEFT JOIN LATERAL (
      SELECT aj.id, aj.status, aj.error, aj.created_at, aj.started_at, aj.completed_at
      FROM ai_jobs aj
      WHERE aj.operation = 'classify_relevance' AND aj.source_item_id = si.id
      ORDER BY aj.created_at DESC
      LIMIT 1
    ) j ON true
    LEFT JOIN ai_results r ON r.ai_job_id = j.id
    ORDER BY si.created_at DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row): SourceItemClassificationStatusRow => {
    // structured_output is only ever present for a succeeded job -- a
    // lightweight shape check for display purposes, not a re-validation
    // of the schema (classifyRelevance's own Zod schema already validated
    // it before it was persisted).
    const structured =
      row.structured_output && typeof row.structured_output === "object"
        ? (row.structured_output as { relevance?: unknown; confidence?: unknown; reasoning?: unknown })
        : null;
    const relevance =
      structured && (structured.relevance === "relevant" || structured.relevance === "irrelevant" || structured.relevance === "needs_review")
        ? structured.relevance
        : null;
    const confidence = structured && typeof structured.confidence === "number" ? structured.confidence : null;
    const reasoning = structured && typeof structured.reasoning === "string" ? structured.reasoning : null;

    return {
      sourceItemId: row.source_item_id,
      title: row.title,
      url: row.url,
      jobId: row.job_id,
      jobStatus: row.job_status,
      jobError: row.job_error,
      jobCreatedAt: row.job_created_at,
      jobStartedAt: row.job_started_at,
      jobCompletedAt: row.job_completed_at,
      relevance,
      confidence,
      reasoning,
    };
  });
}
