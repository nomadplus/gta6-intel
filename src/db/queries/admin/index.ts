import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import type { DbExecutor } from "@/db/mutations/shared";
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
  claimProposalReviews,
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
      decisionId: adminDecisions.id,
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

/**
 * Phase 5 PR 4: the minimal source-item shape extractClaims needs --
 * structurally identical to getSourceItemForClassification above (same
 * fields), kept as its own function rather than a rename of that one, to
 * avoid an unrelated refactor of an existing, working, differently-named
 * function (Section 2).
 */
export async function getSourceItemForClaimExtraction(sourceItemId: number) {
  const rows = await adminDb
    .select({ id: sourceItems.id, url: sourceItems.url, title: sourceItems.title, excerpt: sourceItems.excerpt })
    .from(sourceItems)
    .where(eq(sourceItems.id, sourceItemId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Phase 5 PR 4 eligibility gate for extract_claims. Exact, locked
 * semantics:
 *   - Considers ONLY succeeded classify_relevance jobs -- a job that is
 *     pending/running/failed is invisible to this query entirely,
 *     regardless of how recent it is. A newer failed/pending/running
 *     classification therefore does NOT invalidate an older succeeded
 *     'relevant' result.
 *   - Returns the relevance value of the MOST RECENTLY COMPLETED
 *     succeeded job -- ORDER BY completed_at DESC (with id DESC as a
 *     deterministic tiebreaker for the vanishingly unlikely case of two
 *     rows sharing a completed_at timestamp), NOT created_at, since
 *     completed_at is the correct anchor for "most recently completed."
 *   - A newer SUCCEEDED 'irrelevant' or 'needs_review' job DOES
 *     supersede an older succeeded 'relevant' one, since both are
 *     eligible for selection and the newer one sorts first.
 *   - No succeeded classify_relevance job has ever existed for this
 *     source item -> null (ineligible). This covers "never classified
 *     at all" and "only ever failed / still in flight" identically.
 *
 * extractClaimsTrigger.ts's single-item eligibility check calls this
 * function directly (appropriate for a per-call guard); the admin list
 * display below (listSourceItemExtractionStatus) computes the identical
 * semantics in one set-based query rather than calling this function
 * once per row, to avoid N+1 round-trips against a potentially large
 * source_items table.
 */
export async function getLatestSuccessfulClassifyRelevanceResult(
  sourceItemId: number
): Promise<"relevant" | "irrelevant" | "needs_review" | null> {
  const result = await adminDb.execute<{ structured_output: unknown }>(sql`
    SELECT r.structured_output
    FROM ai_jobs j
    JOIN ai_results r ON r.ai_job_id = j.id
    WHERE j.operation = 'classify_relevance'
      AND j.source_item_id = ${sourceItemId}
      AND j.status = 'succeeded'
    ORDER BY j.completed_at DESC, j.id DESC
    LIMIT 1
  `);
  return parseRelevanceFromStructuredOutput(result.rows[0]?.structured_output);
}

/** Shared parsing helper -- used by both the single-item eligibility query above and the set-based list query below, so the two can never silently diverge in what counts as a valid relevance value. */
function parseRelevanceFromStructuredOutput(structuredOutput: unknown): "relevant" | "irrelevant" | "needs_review" | null {
  if (structuredOutput && typeof structuredOutput === "object" && "relevance" in structuredOutput) {
    const value = (structuredOutput as { relevance?: unknown }).relevance;
    if (value === "relevant" || value === "irrelevant" || value === "needs_review") return value;
  }
  return null;
}

export interface ExtractedClaimCandidate {
  candidateIndex: number;
  statement: string;
  informationType: string;
  supportingExcerpt: string;
  confidence: number;
  reasoning: string;
  review: {
    action: "approve" | "reject" | "link_existing_claim";
    notes: string | null;
    materializedClaimId: number | null;
  } | null;
}

export interface SourceItemExtractionStatusRow {
  sourceItemId: number;
  title: string | null;
  url: string;
  /** The eligibility gate's result (see getLatestSuccessfulClassifyRelevanceResult) -- null means ineligible: never successfully classified. */
  latestSuccessfulRelevance: "relevant" | "irrelevant" | "needs_review" | null;
  jobId: number | null;
  jobStatus: "pending" | "running" | "succeeded" | "failed" | null;
  jobError: string | null;
  jobCreatedAt: Date | null;
  jobStartedAt: Date | null;
  jobCompletedAt: Date | null;
  /** Result containing candidates; null unless the current latest job succeeded. */
  aiResultId: number | null;
  /** [] both for "extraction not yet run" and for "ran, found zero claims" -- jobStatus distinguishes the two (null vs 'succeeded'). */
  candidates: ExtractedClaimCandidate[];
  /** Only ever non-null alongside an empty candidates array -- see extractClaims.ts's schema constraint. */
  noExtractableClaimsNote: string | null;
}

/**
 * Phase 5 PR 4 admin display query. ONE set-based SQL statement (two
 * LATERAL joins resolved server-side by Postgres, not one query per row
 * issued from application code) -- structurally the same pattern as
 * listSourceItemClassificationStatus above, extended with a second
 * LATERAL subquery that computes this item's eligibility using the
 * EXACT SAME semantics as getLatestSuccessfulClassifyRelevanceResult
 * (succeeded-only, ORDER BY completed_at DESC, id DESC) -- duplicated as
 * inline SQL here rather than calling that function per row, which is
 * precisely the N+1 pattern this query is designed to avoid.
 */
export async function listSourceItemExtractionStatus(limit = 50) {
  const result = await adminDb.execute<{
    source_item_id: number;
    title: string | null;
    url: string;
    latest_relevance_structured_output: unknown;
    job_id: number | null;
    job_status: "pending" | "running" | "succeeded" | "failed" | null;
    job_error: string | null;
    job_created_at: Date | null;
    job_started_at: Date | null;
    job_completed_at: Date | null;
    ai_result_id: number | null;
    structured_output: unknown;
  }>(sql`
    SELECT
      si.id AS source_item_id,
      si.title,
      si.url,
      rel.structured_output AS latest_relevance_structured_output,
      j.id AS job_id,
      j.status AS job_status,
      j.error AS job_error,
      j.created_at AS job_created_at,
      j.started_at AS job_started_at,
      j.completed_at AS job_completed_at,
      r.id AS ai_result_id,
      r.structured_output AS structured_output
    FROM source_items si
    LEFT JOIN LATERAL (
      SELECT cr.structured_output
      FROM ai_jobs cj
      JOIN ai_results cr ON cr.ai_job_id = cj.id
      WHERE cj.operation = 'classify_relevance' AND cj.source_item_id = si.id AND cj.status = 'succeeded'
      ORDER BY cj.completed_at DESC, cj.id DESC
      LIMIT 1
    ) rel ON true
    LEFT JOIN LATERAL (
      SELECT aj.id, aj.status, aj.error, aj.created_at, aj.started_at, aj.completed_at
      FROM ai_jobs aj
      WHERE aj.operation = 'extract_claims' AND aj.source_item_id = si.id
      ORDER BY aj.created_at DESC
      LIMIT 1
    ) j ON true
    LEFT JOIN ai_results r ON r.ai_job_id = j.id
    ORDER BY si.created_at DESC
    LIMIT ${limit}
  `);

  // One extraction result can hold multiple candidate decisions. Fetch all
  // those decisions in one batch, rather than adding a query per source item
  // or candidate to the review page.
  const resultIds = result.rows.flatMap((row) => (row.ai_result_id === null ? [] : [row.ai_result_id]));
  const reviewRows = resultIds.length === 0
    ? []
    : await adminDb
        .select({
          aiResultId: claimProposalReviews.aiResultId,
          candidateIndex: claimProposalReviews.candidateIndex,
          action: adminDecisions.action,
          notes: adminDecisions.notes,
          materializedClaimId: claimProposalReviews.materializedClaimId,
        })
        .from(claimProposalReviews)
        .innerJoin(adminDecisions, eq(adminDecisions.id, claimProposalReviews.adminDecisionId))
        .where(inArray(claimProposalReviews.aiResultId, resultIds));
  const reviewsByCandidate = new Map(
    reviewRows.map((review) => [`${review.aiResultId}:${review.candidateIndex}`, review])
  );

  return result.rows.map((row): SourceItemExtractionStatusRow => {
    const latestSuccessfulRelevance = parseRelevanceFromStructuredOutput(row.latest_relevance_structured_output);

    // structured_output is only ever present for a succeeded extract_claims
    // job -- a lightweight shape check for display purposes, not a
    // re-validation of the schema (extractClaims's own Zod schema already
    // validated it before it was persisted).
    let candidates: ExtractedClaimCandidate[] = [];
    let noExtractableClaimsNote: string | null = null;
    const structured = row.structured_output;
    if (structured && typeof structured === "object") {
      const claimsField = (structured as { claims?: unknown }).claims;
      if (Array.isArray(claimsField)) {
        candidates = claimsField.flatMap((c, candidateIndex): ExtractedClaimCandidate[] => {
          if (
            !c ||
            typeof c !== "object" ||
            typeof (c as Omit<ExtractedClaimCandidate, "candidateIndex" | "review">).statement !== "string" ||
            typeof (c as Omit<ExtractedClaimCandidate, "candidateIndex" | "review">).informationType !== "string" ||
            typeof (c as Omit<ExtractedClaimCandidate, "candidateIndex" | "review">).supportingExcerpt !== "string" ||
            typeof (c as Omit<ExtractedClaimCandidate, "candidateIndex" | "review">).confidence !== "number" ||
            typeof (c as Omit<ExtractedClaimCandidate, "candidateIndex" | "review">).reasoning !== "string"
          ) {
            return [];
          }
          const review = row.ai_result_id === null ? undefined : reviewsByCandidate.get(`${row.ai_result_id}:${candidateIndex}`);
          return [{
            candidateIndex,
            statement: (c as { statement: string }).statement,
            informationType: (c as { informationType: string }).informationType,
            supportingExcerpt: (c as { supportingExcerpt: string }).supportingExcerpt,
            confidence: (c as { confidence: number }).confidence,
            reasoning: (c as { reasoning: string }).reasoning,
            review: review && (review.action === "approve" || review.action === "reject" || review.action === "link_existing_claim")
              ? { action: review.action, notes: review.notes, materializedClaimId: review.materializedClaimId }
              : null,
          }];
        });
      }
      const noteField = (structured as { noExtractableClaimsNote?: unknown }).noExtractableClaimsNote;
      noExtractableClaimsNote = typeof noteField === "string" ? noteField : null;
    }

    return {
      sourceItemId: row.source_item_id,
      title: row.title,
      url: row.url,
      latestSuccessfulRelevance,
      jobId: row.job_id,
      jobStatus: row.job_status,
      jobError: row.job_error,
      jobCreatedAt: row.job_created_at,
      jobStartedAt: row.job_started_at,
      jobCompletedAt: row.job_completed_at,
      aiResultId: row.ai_result_id,
      candidates,
      noExtractableClaimsNote,
    };
  });
}

/* =========================================================================
 * PHASE 5 PR 6 -- duplicate-detection query helpers.
 *
 * Deliberately neutral: every function below returns plain data, null, or
 * a boolean -- never a domain/user-facing error. Orchestration
 * (src/lib/ai/operations/detectDuplicatesTrigger.ts) and mutation
 * (src/db/mutations/claimProposalReviews.ts,
 * src/db/mutations/detectDuplicatesRecovery.ts) layers translate a null/
 * false/empty result into whichever error class is actually theirs to
 * own. This module also does not import anything from src/lib/ai --
 * getExtractionCandidate (the one helper that DOES need extract_claims'
 * own Zod schema to parse a candidate out of stored JSON) therefore stays
 * exported from src/db/mutations/claimProposalReviews.ts instead of living
 * here, rather than pulling an AI-operation-specific schema into the
 * generic query layer.
 * ========================================================================= */

/**
 * Whether ANY human decision -- approve, reject, or link_existing_claim --
 * has already been recorded for this exact extract_claims candidate. Pure
 * fact, no error thrown here; every caller (assertProposalIsUnreviewed in
 * claimProposalReviews.ts, the eligibility gate in
 * detectDuplicatesTrigger.ts/detectDuplicatesRecovery.ts) decides its own
 * error for a true result.
 */
export async function isProposalReviewed(db: DbExecutor, aiResultId: number, candidateIndex: number): Promise<boolean> {
  const rows = await db
    .select({ id: claimProposalReviews.id })
    .from(claimProposalReviews)
    .where(and(eq(claimProposalReviews.aiResultId, aiResultId), eq(claimProposalReviews.candidateIndex, candidateIndex)))
    .limit(1);
  return rows.length > 0;
}

export interface PersistedDuplicateMatch {
  existingClaimId: number;
  confidence: number;
  reasoning: string;
}

/**
 * The LATEST SUCCEEDED detect_duplicates job's persisted matches for one
 * exact extract_claims candidate -- same "succeeded-only, ORDER BY
 * completed_at DESC, id DESC" semantics as
 * getLatestSuccessfulClassifyRelevanceResult above, just keyed by
 * (extraction_ai_result_id, extraction_candidate_index) instead of
 * source_item_id (see migration 0018). Returns null when no succeeded
 * check has ever completed for this candidate -- distinct from an empty
 * array, which is itself a valid "checked, no likely duplicate" result.
 * Shape-checked defensively (mirroring the candidate-shape guard in
 * listSourceItemExtractionStatus above) rather than re-run through
 * detect_duplicates' own Zod schema, since that schema is parameterized
 * by the exact candidate-claim-id set a given call was offered, which
 * this read has no reason to reconstruct.
 */
export async function getLatestDetectDuplicatesMatches(
  db: DbExecutor,
  aiResultId: number,
  candidateIndex: number
): Promise<PersistedDuplicateMatch[] | null> {
  const result = await db.execute<{ structured_output: unknown }>(sql`
    SELECT r.structured_output
    FROM ai_jobs j
    JOIN ai_results r ON r.ai_job_id = j.id
    WHERE j.operation = 'detect_duplicates'
      AND j.extraction_ai_result_id = ${aiResultId}
      AND j.extraction_candidate_index = ${candidateIndex}
      AND j.status = 'succeeded'
    ORDER BY j.completed_at DESC, j.id DESC
    LIMIT 1
  `);

  const structured = result.rows[0]?.structured_output;
  if (!structured || typeof structured !== "object") return null;
  const matchesField = (structured as { matches?: unknown }).matches;
  if (!Array.isArray(matchesField)) return null;

  return matchesField.flatMap((m): PersistedDuplicateMatch[] => {
    if (
      !m ||
      typeof m !== "object" ||
      typeof (m as { existingClaimId?: unknown }).existingClaimId !== "number" ||
      typeof (m as { confidence?: unknown }).confidence !== "number" ||
      typeof (m as { reasoning?: unknown }).reasoning !== "string"
    ) {
      return [];
    }
    return [
      {
        existingClaimId: (m as { existingClaimId: number }).existingClaimId,
        confidence: (m as { confidence: number }).confidence,
        reasoning: (m as { reasoning: string }).reasoning,
      },
    ];
  });
}

/**
 * The most recent detect_duplicates ai_jobs row for one exact candidate
 * (any status) -- for admin display and for the recovery mutation's
 * staleness check. Distinct from getLatestDetectDuplicatesMatches above,
 * which is succeeded-only and returns parsed matches, not the raw job
 * row.
 */
export interface DetectDuplicatesJobForDisplay {
  id: number;
  status: "pending" | "running" | "succeeded" | "failed";
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export async function getLatestDetectDuplicatesJob(
  db: DbExecutor,
  aiResultId: number,
  candidateIndex: number
): Promise<DetectDuplicatesJobForDisplay | null> {
  const rows = await db
    .select({
      id: aiJobs.id,
      status: aiJobs.status,
      error: aiJobs.error,
      createdAt: aiJobs.createdAt,
      startedAt: aiJobs.startedAt,
      completedAt: aiJobs.completedAt,
    })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.operation, "detect_duplicates"),
        eq(aiJobs.extractionAiResultId, aiResultId),
        eq(aiJobs.extractionCandidateIndex, candidateIndex)
      )
    )
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Plain existence/id check -- claims are never hard-deleted in this codebase, so this is defensive, not load-bearing. */
export async function getClaimByIdForResolution(db: DbExecutor, claimId: number): Promise<{ id: number } | null> {
  const rows = await db.select({ id: claims.id }).from(claims).where(eq(claims.id, claimId)).limit(1);
  return rows[0] ?? null;
}

/** How many claims exist for a project -- the deterministic "is there anything to compare against" fact behind the no_existing_claims display state. */
export async function countClaimsForProject(db: DbExecutor, projectId: number): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(claims).where(eq(claims.projectId, projectId));
  return rows[0]?.count ?? 0;
}

export interface DuplicateCandidateClaim {
  id: number;
  statement: string;
}

/** Every claim for a project -- the small-dataset branch of PR6's tiered retrieval (see detectDuplicatesTrigger.ts for the threshold decision). */
export async function listClaimsForProject(db: DbExecutor, projectId: number): Promise<DuplicateCandidateClaim[]> {
  return db.select({ id: claims.id, statement: claims.statement }).from(claims).where(eq(claims.projectId, projectId));
}

/**
 * Deterministic lexical pre-filter for the large-dataset branch of PR6's
 * tiered retrieval -- ranks existing claims within one project by
 * pg_trgm similarity to the candidate's statement and returns at most
 * `limit` rows. Uses the fully qualified extensions.similarity(...)
 * (migration 0017) rather than relying on search_path. No trigram index
 * backs this query in PR6 (deliberately -- see migration 0017's own
 * header): a sequential scan computing similarity per row is fast at
 * this project's current scale, and this function's job is only to
 * bound the AI call's input size, not to be the fastest possible
 * ranking.
 */
export async function listClaimsByTrigramSimilarity(
  db: DbExecutor,
  projectId: number,
  candidateStatement: string,
  limit: number
): Promise<DuplicateCandidateClaim[]> {
  const result = await db.execute<{ id: number; statement: string }>(sql`
    SELECT id, statement
    FROM claims
    WHERE project_id = ${projectId}
    ORDER BY extensions.similarity(statement, ${candidateStatement}) DESC
    LIMIT ${limit}
  `);
  return result.rows;
}
