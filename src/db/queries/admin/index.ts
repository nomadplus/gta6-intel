import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  claimRelationships,
  claimComparisonReviews,
  claimSources,
  sourceRelationships,
  sourceRelationshipReviews,
  aiJobs,
  ingestionJobs,
  discoveryProviders,
  discoveryFeeds,
  sourceItemLinks,
} from "@/db/schema";
import type { ClaimScopedSourceRelationshipRow } from "@/lib/provenanceSummary";

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

export interface AdminOutboundLinkRow {
  id: number;
  targetUrl: string;
  anchorText: string | null;
  linkContextSnippet: string | null;
  placement: "content" | "chrome" | "ambiguous";
  isSameSite: boolean;
  toSourceItemId: number | null;
  toSourceItemTitle: string | null;
  toSourceItemUrl: string | null;
}

/**
 * Phase 6 prerequisite: read-only outbound-link OBSERVATIONS for one
 * source item's own admin detail page -- deliberately separate from
 * getSourceItemRelationships above, which reads the epistemic
 * source_relationships graph. This never joins into or implies anything
 * about source_relationships; it is purely "what did this item's fetched
 * HTML contain." No mutation function accompanies this query -- the admin
 * page renders it read-only, with no edit/delete/resolve/promote control.
 */
export async function getOutboundSourceItemLinksForAdmin(sourceItemId: number): Promise<AdminOutboundLinkRow[]> {
  const rows = await adminDb
    .select({
      id: sourceItemLinks.id,
      targetUrl: sourceItemLinks.targetUrl,
      anchorText: sourceItemLinks.anchorText,
      linkContextSnippet: sourceItemLinks.linkContextSnippet,
      placement: sourceItemLinks.placement,
      isSameSite: sourceItemLinks.isSameSite,
      toSourceItemId: sourceItemLinks.toSourceItemId,
      toSourceItemTitle: sourceItems.title,
      toSourceItemUrl: sourceItems.url,
    })
    .from(sourceItemLinks)
    .leftJoin(sourceItems, eq(sourceItems.id, sourceItemLinks.toSourceItemId))
    .where(eq(sourceItemLinks.fromSourceItemId, sourceItemId))
    .orderBy(sourceItemLinks.linkPosition);
  return rows;
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
/**
 * Phase 6 PR-B: extended with a read-only join to `sources` so
 * extractClaims can classify officialBasis against the source's own
 * CURATED identity (sources.name/homepageUrl -- admin-entered via
 * createSource/updateSource, requireAdmin("editor")-gated) rather than
 * inferring first-party-vs-third-party solely from this item's own raw
 * URL string, which is a weaker signal. This is a read, not a mutation:
 * no schema change, no new column, no write-path change. sourceName/
 * sourceHomepageUrl are passed through purely as classification context
 * -- see extractClaims.ts's ExtractableSourceItem doc comment for why
 * this must never be treated as a provenance conclusion.
 */
export async function getSourceItemForClaimExtraction(sourceItemId: number) {
  const rows = await adminDb
    .select({
      id: sourceItems.id,
      url: sourceItems.url,
      title: sourceItems.title,
      excerpt: sourceItems.excerpt,
      sourceName: sources.name,
      sourceHomepageUrl: sources.homepageUrl,
    })
    .from(sourceItems)
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
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
  /**
   * Phase 6 PR-B, advisory-only. Optional because historical ai_results
   * rows written before this PR lack the key entirely -- absence is a
   * normal, valid state (pre-PR-B row), not a data error. Never treat
   * this as a provenance/originality/independence conclusion, and never
   * pass it to any claim mutation -- see extractClaims.ts.
   */
  officialBasis?: "direct_official_material" | "reported_official_material" | "not_applicable_or_unclear";
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
          // Phase 6 PR-B: officialBasis is read defensively and optionally --
          // absent entirely on any ai_results row written before this PR,
          // and its presence/shape here never re-validates a value's
          // membership in the enum (the same "display-only, not a
          // schema re-check" precedent already used for the other fields
          // in this block).
          const rawOfficialBasis = (c as { officialBasis?: unknown }).officialBasis;
          const officialBasis =
            rawOfficialBasis === "direct_official_material" ||
            rawOfficialBasis === "reported_official_material" ||
            rawOfficialBasis === "not_applicable_or_unclear"
              ? rawOfficialBasis
              : undefined;
          return [{
            candidateIndex,
            statement: (c as { statement: string }).statement,
            informationType: (c as { informationType: string }).informationType,
            supportingExcerpt: (c as { supportingExcerpt: string }).supportingExcerpt,
            confidence: (c as { confidence: number }).confidence,
            reasoning: (c as { reasoning: string }).reasoning,
            officialBasis,
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

/* =========================================================================
 * Phase 5 PR 7: compare_claims relationship-analysis query helpers.
 * ========================================================================= */

/** The focus claim's own identity for the compare_claims shortlist and approval-time checks -- id, statement (for the AI call/ranking), and projectId (for shortlist scoping and the same-project assertion at approval time). */
export async function getClaimForComparison(
  db: DbExecutor,
  claimId: number
): Promise<{ id: number; statement: string; projectId: number } | null> {
  const rows = await db
    .select({ id: claims.id, statement: claims.statement, projectId: claims.projectId })
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);
  return rows[0] ?? null;
}

export interface ComparableClaim {
  id: number;
  statement: string;
}

/**
 * Shared exclusion rule for all three PR7 shortlist queries below: same
 * project, not the focus claim itself, and NOT already linked to the
 * focus claim by any existing claim_relationships row in EITHER
 * direction (locked decision -- re-analysis/multi-type semantics for an
 * already-related pair are deferred to a later PR). Expressed once as a
 * SQL fragment reused by all three queries rather than three
 * independently-maintained copies of the same predicate.
 */
function comparableClaimsPredicate(claimId: number, projectId: number) {
  return sql`c.project_id = ${projectId}
    AND c.id <> ${claimId}
    AND NOT EXISTS (
      SELECT 1 FROM claim_relationships cr
      WHERE (cr.claim_id_a = ${claimId} AND cr.claim_id_b = c.id)
         OR (cr.claim_id_a = c.id AND cr.claim_id_b = ${claimId})
    )`;
}

/** How many claims exist that compare_claims could still meaningfully analyse against this focus claim -- the deterministic "is there anything to compare against" fact behind the no_comparable_claims display state. Recomputed fresh on every render; NOT monotonic (see relationshipAnalysisActionability.ts's header). */
export async function countComparableClaimsForClaim(db: DbExecutor, claimId: number, projectId: number): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM claims c
    WHERE ${comparableClaimsPredicate(claimId, projectId)}
  `);
  return result.rows[0]?.count ?? 0;
}

/** Every comparable claim for a project -- the small-dataset branch of PR7's tiered retrieval (see compareClaimsTrigger.ts for the threshold decision). */
export async function listComparableClaimsForClaim(db: DbExecutor, claimId: number, projectId: number): Promise<ComparableClaim[]> {
  const result = await db.execute<{ id: number; statement: string }>(sql`
    SELECT c.id, c.statement
    FROM claims c
    WHERE ${comparableClaimsPredicate(claimId, projectId)}
    ORDER BY c.id
  `);
  return result.rows;
}

/**
 * Deterministic lexical pre-filter for the large-dataset branch of PR7's
 * tiered retrieval -- ranks comparable claims within one project by
 * pg_trgm similarity to the focus claim's statement and returns at most
 * `limit` rows. Same extensions.similarity(...) usage and same "no
 * trigram index backing this in PR7 -- a sequential scan is fast at this
 * project's current scale" reasoning as listClaimsByTrigramSimilarity
 * above (PR6). KNOWN, DOCUMENTED LIMITATION (see compareClaimsTrigger.ts
 * and docs/architecture.md): lexical similarity is a poor proxy for
 * "contradicts" or abstraction-level "subsumes"/"refines" pairs, which
 * need not share vocabulary at all. This produces false negatives
 * (relationships that exist but are never surfaced), never false
 * positives -- every surfaced recommendation still requires human
 * approval. Solving this properly needs semantic (embedding-based)
 * retrieval, which is deliberately out of scope for PR7 and belongs in
 * the future Autonomous Web Discovery phase, when claim volume makes it
 * necessary and provides real data to tune it against.
 */
export async function listComparableClaimsByTrigramSimilarity(
  db: DbExecutor,
  claimId: number,
  projectId: number,
  focusStatement: string,
  limit: number
): Promise<ComparableClaim[]> {
  const result = await db.execute<{ id: number; statement: string }>(sql`
    SELECT c.id, c.statement
    FROM claims c
    WHERE ${comparableClaimsPredicate(claimId, projectId)}
    ORDER BY extensions.similarity(c.statement, ${focusStatement}) DESC
    LIMIT ${limit}
  `);
  return result.rows;
}

export interface CompareClaimsJobForDisplayRow {
  id: number;
  status: "pending" | "running" | "succeeded" | "failed";
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** The most recent compare_claims ai_jobs row for one focus claim (any status) -- for admin display and for the recovery mutation's staleness check. Distinct from getLatestSuccessfulCompareClaimsResult below, which is succeeded-only and returns parsed assessments, not the raw job row. */
export async function getLatestCompareClaimsJob(db: DbExecutor, claimId: number): Promise<CompareClaimsJobForDisplayRow | null> {
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
    .where(and(eq(aiJobs.operation, "compare_claims"), eq(aiJobs.comparisonClaimId, claimId)))
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface PersistedComparisonAssessment {
  otherClaimId: number;
  relationshipType: string;
  direction: "focus_to_other" | "other_to_focus" | null;
  confidence: number;
  reasoning: string;
}

export interface LatestCompareClaimsResult {
  aiResultId: number;
  assessments: PersistedComparisonAssessment[];
}

/**
 * The LATEST SUCCEEDED compare_claims job's persisted assessments for one
 * focus claim -- same "succeeded-only, ORDER BY completed_at DESC, id
 * DESC" semantics as getLatestSuccessfulClassifyRelevanceResult /
 * getLatestDetectDuplicatesMatches, just keyed by comparison_claim_id
 * instead of source_item_id / the extraction pair. Returns null when no
 * succeeded analysis has ever completed for this claim -- distinct from
 * an empty assessments array, which is itself a valid "analysed, no
 * meaningful relationship found" result.
 *
 * Shape-checked defensively (mirroring getLatestDetectDuplicatesMatches)
 * rather than re-run through compare_claims' own Zod schema
 * (buildCompareClaimsOutputSchema), since that schema is parameterized
 * by the exact focus claim + candidate-claim-id set a given call was
 * offered -- an ephemeral input to that one call, never persisted in its
 * own right -- which this read has no reason (or ability) to
 * reconstruct. Approval-time re-verification of one specific assessment
 * against a tampered/stale form value happens in
 * claimComparisonReviews.ts's getComparisonAssessment, using this exact
 * same defensive-parse approach, not a full schema reconstruction.
 */
export async function getLatestSuccessfulCompareClaimsResult(
  db: DbExecutor,
  claimId: number
): Promise<LatestCompareClaimsResult | null> {
  const result = await db.execute<{ id: number; structured_output: unknown }>(sql`
    SELECT r.id, r.structured_output
    FROM ai_jobs j
    JOIN ai_results r ON r.ai_job_id = j.id
    WHERE j.operation = 'compare_claims'
      AND j.comparison_claim_id = ${claimId}
      AND j.status = 'succeeded'
    ORDER BY j.completed_at DESC, j.id DESC
    LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) return null;
  const structured = row.structured_output;
  if (!structured || typeof structured !== "object") return null;
  const assessmentsField = (structured as { assessments?: unknown }).assessments;
  if (!Array.isArray(assessmentsField)) return null;

  const assessments = assessmentsField.flatMap((a): PersistedComparisonAssessment[] => {
    if (
      !a ||
      typeof a !== "object" ||
      typeof (a as { otherClaimId?: unknown }).otherClaimId !== "number" ||
      typeof (a as { relationshipType?: unknown }).relationshipType !== "string" ||
      typeof (a as { confidence?: unknown }).confidence !== "number" ||
      typeof (a as { reasoning?: unknown }).reasoning !== "string"
    ) {
      return [];
    }
    const rawDirection = (a as { direction?: unknown }).direction;
    const direction = rawDirection === "focus_to_other" || rawDirection === "other_to_focus" ? rawDirection : null;
    return [
      {
        otherClaimId: (a as { otherClaimId: number }).otherClaimId,
        relationshipType: (a as { relationshipType: string }).relationshipType,
        direction,
        confidence: (a as { confidence: number }).confidence,
        reasoning: (a as { reasoning: string }).reasoning,
      },
    ];
  });

  return { aiResultId: row.id, assessments };
}

/** Whether ANY human decision -- approve, edit, or reject -- has already been recorded for this exact compare_claims assessment. Pure fact, no error thrown here; every caller decides its own error for a true result -- same shape as isProposalReviewed above. */
export async function isComparisonReviewed(db: DbExecutor, aiResultId: number, assessmentIndex: number): Promise<boolean> {
  const rows = await db
    .select({ id: claimComparisonReviews.id })
    .from(claimComparisonReviews)
    .where(and(eq(claimComparisonReviews.aiResultId, aiResultId), eq(claimComparisonReviews.assessmentIndex, assessmentIndex)))
    .limit(1);
  return rows.length > 0;
}

export interface ComparisonReviewOutcome {
  assessmentIndex: number;
  action: string;
  notes: string | null;
  approvedClaimIdA: number | null;
  approvedClaimIdB: number | null;
  approvedRelationshipType: string | null;
  materializedRelationshipId: number | null;
  relationshipWasNewlyCreated: boolean | null;
}

/** Every recorded review decision for one compare_claims ai_result, for rendering each assessment's outcome (or lack thereof) on the claim detail page. One query per page render, not one per assessment. */
export async function listComparisonReviewsForResult(db: DbExecutor, aiResultId: number): Promise<ComparisonReviewOutcome[]> {
  return db
    .select({
      assessmentIndex: claimComparisonReviews.assessmentIndex,
      action: adminDecisions.action,
      notes: adminDecisions.notes,
      approvedClaimIdA: claimComparisonReviews.approvedClaimIdA,
      approvedClaimIdB: claimComparisonReviews.approvedClaimIdB,
      approvedRelationshipType: claimComparisonReviews.approvedRelationshipType,
      materializedRelationshipId: claimComparisonReviews.materializedRelationshipId,
      relationshipWasNewlyCreated: claimComparisonReviews.relationshipWasNewlyCreated,
    })
    .from(claimComparisonReviews)
    .innerJoin(adminDecisions, eq(adminDecisions.id, claimComparisonReviews.adminDecisionId))
    .where(eq(claimComparisonReviews.aiResultId, aiResultId));
}

/** Plain existence/statement lookup for resolving otherClaimId -> statement across a small batch of ids (at most COMPARE_CLAIMS_MAX_CANDIDATES) for display -- claims are never hard-deleted in this codebase, so a miss here is defensive, not load-bearing. */
export async function listClaimsByIds(db: DbExecutor, ids: number[]): Promise<{ id: number; statement: string; slug: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: claims.id, statement: claims.statement, slug: claims.slug }).from(claims).where(inArray(claims.id, ids));
}

/* =========================================================================
 * Phase 5 PR 8b: analyse_provenance query helpers.
 * ========================================================================= */

/** The anchor claim's own identity for the analyse_provenance trigger and approval-time checks -- id, statement (for the AI call), and projectId (display only -- the cluster itself is never project-filtered, see analyseProvenanceTrigger.ts's header). */
export async function getClaimForProvenanceAnalysis(
  db: DbExecutor,
  claimId: number
): Promise<{ id: number; statement: string; projectId: number } | null> {
  const rows = await db
    .select({ id: claims.id, statement: claims.statement, projectId: claims.projectId })
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);
  return rows[0] ?? null;
}

export interface ProvenanceClusterItem {
  id: number;
  title: string | null;
  url: string;
  publishedAt: Date | null;
  excerpt: string | null;
}

/**
 * The claim-anchored source-item cluster: every DISTINCT source item
 * linked to this claim via claim_sources, ordered deterministically by
 * source_item id and capped at `limit` (PROVENANCE_CLUSTER_HARD_CAP) --
 * the SQL LIMIT is the actual truncation boundary, not application-level
 * slicing (see analyseProvenanceTrigger.ts). A claim can link the same
 * source item only once (claim_sources_unique), so no DISTINCT is needed
 * at the SQL level beyond the join itself.
 */
export async function getProvenanceClusterForClaim(
  db: DbExecutor,
  claimId: number,
  limit: number
): Promise<ProvenanceClusterItem[]> {
  return db
    .select({
      id: sourceItems.id,
      title: sourceItems.title,
      url: sourceItems.url,
      publishedAt: sourceItems.publishedAt,
      excerpt: sourceItems.excerpt,
    })
    .from(claimSources)
    .innerJoin(sourceItems, eq(sourceItems.id, claimSources.sourceItemId))
    .where(eq(claimSources.claimId, claimId))
    .orderBy(sourceItems.id)
    .limit(limit);
}

/**
 * Phase 6 PR-C: every source item id attached to this claim via
 * claim_sources -- deliberately UNCAPPED, unlike getProvenanceClusterForClaim
 * above (whose PROVENANCE_CLUSTER_HARD_CAP exists only to bound what is
 * sent to the AI model). The claim-level provenance summary must reflect
 * the claim's FULL attached source set: a claim with more than 15
 * attached sources must not silently receive a truncated, misleadingly
 * incomplete structural summary.
 */
export async function getAttachedSourceItemIdsForClaim(db: DbExecutor, claimId: number): Promise<number[]> {
  const rows = await db.select({ id: claimSources.sourceItemId }).from(claimSources).where(eq(claimSources.claimId, claimId));
  return rows.map((r) => r.id);
}

/**
 * Phase 6 PR-C: source_relationships rows eligible to affect claim
 * `attachedSourceItemIds`'s deterministic provenance summary -- BOTH
 * `sourceItemIdA` and `sourceItemIdB` must be in the caller-supplied
 * attached-source-item-id set for this exact claim (the locked PR-C scope
 * rule). This is DELIBERATELY STRICTER than getClaimProvenanceChain
 * (src/db/queries/claimDetail.ts), which matches on EITHER endpoint for
 * the existing public reader's own, separately decided purpose --
 * getClaimProvenanceChain and ProvenanceChain.tsx are both untouched by
 * PR-C; whether the public reader should also become strictly
 * claim-internal is deferred to PR-D.
 *
 * A source item can legitimately be attached to more than one claim
 * (claim_sources is unique only per claim+item, not per item alone), so
 * this query must never let a relationship whose OTHER endpoint belongs
 * only to a different claim leak into this claim's own summary -- see
 * the DB-backed regression check (provenanceSummaryScope.check.ts) for
 * the exact fixture proving this.
 */
export async function getClaimScopedSourceRelationships(
  db: DbExecutor,
  attachedSourceItemIds: number[]
): Promise<ClaimScopedSourceRelationshipRow[]> {
  if (attachedSourceItemIds.length === 0) return [];
  return db
    .select({
      sourceItemIdA: sourceRelationships.sourceItemIdA,
      sourceItemIdB: sourceRelationships.sourceItemIdB,
      relationshipType: sourceRelationships.relationshipType,
    })
    .from(sourceRelationships)
    .where(
      and(inArray(sourceRelationships.sourceItemIdA, attachedSourceItemIds), inArray(sourceRelationships.sourceItemIdB, attachedSourceItemIds))
    );
}

export interface InClusterLinkRow {
  fromSourceItemId: number;
  toSourceItemId: number;
  anchorText: string | null;
  contextSnippet: string | null;
  placement: "content" | "chrome" | "ambiguous";
  isSameSite: boolean;
  linkPosition: number;
}

/**
 * Phase 6 prerequisite: every RESOLVED source_item_links row whose
 * from/to are BOTH inside this claim's own provenance cluster -- the only
 * link evidence analyseProvenanceTrigger.ts is permitted to forward into
 * analyse_provenance's prompt (Section 11 of the PR spec: never an
 * unresolved link, never an out-of-cluster target, never an arbitrary
 * outbound URL merely because it was extracted). `clusterItemIds` is the
 * exact same id set getProvenanceClusterForClaim just produced -- both
 * endpoints are checked via `inArray` against that same set, so a link
 * resolving to a real source_items row that simply isn't part of THIS
 * claim's cluster is correctly excluded.
 */
export async function getInClusterLinksForCluster(
  db: DbExecutor,
  clusterItemIds: number[]
): Promise<InClusterLinkRow[]> {
  if (clusterItemIds.length === 0) return [];
  const rows = await db
    .select({
      fromSourceItemId: sourceItemLinks.fromSourceItemId,
      toSourceItemId: sourceItemLinks.toSourceItemId,
      anchorText: sourceItemLinks.anchorText,
      contextSnippet: sourceItemLinks.linkContextSnippet,
      placement: sourceItemLinks.placement,
      isSameSite: sourceItemLinks.isSameSite,
      linkPosition: sourceItemLinks.linkPosition,
    })
    .from(sourceItemLinks)
    .where(
      and(
        inArray(sourceItemLinks.fromSourceItemId, clusterItemIds),
        inArray(sourceItemLinks.toSourceItemId, clusterItemIds),
        // Defense-in-depth alongside the inArray-against-a-nullable-column
        // behavior above (SQL IN never matches NULL): explicit, so intent
        // is unambiguous regardless of driver/ORM quirks -- unresolved
        // links must never reach this query's caller.
        isNotNull(sourceItemLinks.toSourceItemId)
      )
    )
    .orderBy(sourceItemLinks.fromSourceItemId, sourceItemLinks.linkPosition);

  // The isNotNull filter above guarantees toSourceItemId is never null at
  // runtime; this narrows the column's nullable static type to match, so
  // callers get a genuinely non-null `number`, not `number | null`.
  return rows.map((r) => ({ ...r, toSourceItemId: r.toSourceItemId! }));
}

export interface ProvenanceAnalysisJobForDisplayRow {
  id: number;
  status: "pending" | "running" | "succeeded" | "failed";
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** The most recent analyse_provenance ai_jobs row for one anchor claim (any status) -- for admin display and for the recovery mutation's staleness check. Distinct from getLatestSuccessfulProvenanceAnalysisResult below, which is succeeded-only and returns parsed edges, not the raw job row. */
export async function getLatestProvenanceAnalysisJob(db: DbExecutor, claimId: number): Promise<ProvenanceAnalysisJobForDisplayRow | null> {
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
    .where(and(eq(aiJobs.operation, "analyse_provenance"), eq(aiJobs.provenanceClaimId, claimId)))
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface PersistedProvenanceEdge {
  fromSourceItemId: number;
  toSourceItemId: number;
  relationshipType: string;
  basis: string;
  confidence: number;
  reasoning: string;
  distinctEvidenceSummary: string | null;
}

export interface LatestProvenanceAnalysisResult {
  aiJobId: number;
  aiResultId: number;
  clusterFingerprint: string | null;
  edges: PersistedProvenanceEdge[];
}

/**
 * The LATEST SUCCEEDED analyse_provenance job's persisted edges for one
 * anchor claim -- same "succeeded-only, ORDER BY completed_at DESC, id
 * DESC" semantics as getLatestSuccessfulCompareClaimsResult, just keyed by
 * provenance_claim_id instead of comparison_claim_id, and additionally
 * returning the job's own provenance_cluster_fingerprint (needed for the
 * fingerprint-gated reanalyse action -- see
 * provenanceAnalysisActionability.ts). Returns null when no succeeded
 * analysis has ever completed for this claim -- distinct from an empty
 * edges array, which is itself a valid "analysed, no meaningful
 * relationship found" result.
 *
 * Shape-checked defensively (mirroring getLatestSuccessfulCompareClaimsResult)
 * rather than re-run through analyse_provenance's own Zod schema
 * (buildAnalyseProvenanceOutputSchema), since that schema is parameterized
 * by the exact cluster-item-id set a given call was offered -- an
 * ephemeral input to that one call, never persisted in its own right --
 * which this read has no reason (or ability) to reconstruct.
 */
export async function getLatestSuccessfulProvenanceAnalysisResult(
  db: DbExecutor,
  claimId: number
): Promise<LatestProvenanceAnalysisResult | null> {
  const result = await db.execute<{ ai_job_id: number; id: number; structured_output: unknown; provenance_cluster_fingerprint: string | null }>(sql`
    SELECT j.id AS ai_job_id, r.id, r.structured_output, j.provenance_cluster_fingerprint
    FROM ai_jobs j
    JOIN ai_results r ON r.ai_job_id = j.id
    WHERE j.operation = 'analyse_provenance'
      AND j.provenance_claim_id = ${claimId}
      AND j.status = 'succeeded'
    ORDER BY j.completed_at DESC, j.id DESC
    LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) return null;
  const structured = row.structured_output;
  if (!structured || typeof structured !== "object") return null;
  const edgesField = (structured as { edges?: unknown }).edges;
  if (!Array.isArray(edgesField)) return null;

  const edges = edgesField.flatMap((e): PersistedProvenanceEdge[] => {
    if (
      !e ||
      typeof e !== "object" ||
      typeof (e as { fromSourceItemId?: unknown }).fromSourceItemId !== "number" ||
      typeof (e as { toSourceItemId?: unknown }).toSourceItemId !== "number" ||
      typeof (e as { relationshipType?: unknown }).relationshipType !== "string" ||
      typeof (e as { basis?: unknown }).basis !== "string" ||
      typeof (e as { confidence?: unknown }).confidence !== "number" ||
      typeof (e as { reasoning?: unknown }).reasoning !== "string"
    ) {
      return [];
    }
    const rawSummary = (e as { distinctEvidenceSummary?: unknown }).distinctEvidenceSummary;
    return [
      {
        fromSourceItemId: (e as { fromSourceItemId: number }).fromSourceItemId,
        toSourceItemId: (e as { toSourceItemId: number }).toSourceItemId,
        relationshipType: (e as { relationshipType: string }).relationshipType,
        basis: (e as { basis: string }).basis,
        confidence: (e as { confidence: number }).confidence,
        reasoning: (e as { reasoning: string }).reasoning,
        distinctEvidenceSummary: typeof rawSummary === "string" ? rawSummary : null,
      },
    ];
  });

  return { aiJobId: row.ai_job_id, aiResultId: row.id, clusterFingerprint: row.provenance_cluster_fingerprint, edges };
}

/**
 * Whether the given ai_result_id is the ai_results row belonging to the
 * LATEST SUCCEEDED analyse_provenance job for the given anchor claim --
 * the PR8b-specific server-side supersession check. Unlike PR7's
 * compare_claims review mutations (which check only that the named
 * ai_result_id's own job succeeded, not whether it is still the LATEST
 * succeeded one -- confirmed by direct inspection, not changed here per
 * explicit instruction), PR8b requires this enforced on approve/edit/reject,
 * not merely in the UI. Older results remain preserved for audit but their
 * unreviewed edges become non-actionable once a newer succeeded result
 * exists for the same claim.
 */
export async function isLatestSucceededProvenanceAnalysisResult(db: DbExecutor, claimId: number, aiResultId: number): Promise<boolean> {
  const latest = await getLatestSuccessfulProvenanceAnalysisResult(db, claimId);
  return latest !== null && latest.aiResultId === aiResultId;
}

/** Whether ANY human decision -- approve, edit, or reject -- has already been recorded for this exact analyse_provenance proposed edge. Pure fact, no error thrown here; every caller decides its own error for a true result -- same shape as isComparisonReviewed above. */
export async function isSourceRelationshipReviewed(db: DbExecutor, aiResultId: number, edgeIndex: number): Promise<boolean> {
  const rows = await db
    .select({ id: sourceRelationshipReviews.id })
    .from(sourceRelationshipReviews)
    .where(and(eq(sourceRelationshipReviews.aiResultId, aiResultId), eq(sourceRelationshipReviews.edgeIndex, edgeIndex)))
    .limit(1);
  return rows.length > 0;
}

export interface SourceRelationshipReviewOutcome {
  edgeIndex: number;
  action: string;
  notes: string | null;
  approvedSourceItemIdA: number | null;
  approvedSourceItemIdB: number | null;
  approvedRelationshipType: string | null;
  materializedRelationshipId: number | null;
  relationshipWasNewlyCreated: boolean | null;
}

/** Every recorded review decision for one analyse_provenance ai_result, keyed for display by edgeIndex -- mirrors listComparisonReviewsForResult's shape exactly. */
export async function listSourceRelationshipReviewsForResult(db: DbExecutor, aiResultId: number): Promise<SourceRelationshipReviewOutcome[]> {
  const rows = await db
    .select({
      edgeIndex: sourceRelationshipReviews.edgeIndex,
      action: adminDecisions.action,
      notes: adminDecisions.notes,
      approvedSourceItemIdA: sourceRelationshipReviews.approvedSourceItemIdA,
      approvedSourceItemIdB: sourceRelationshipReviews.approvedSourceItemIdB,
      approvedRelationshipType: sourceRelationshipReviews.approvedRelationshipType,
      materializedRelationshipId: sourceRelationshipReviews.materializedRelationshipId,
      relationshipWasNewlyCreated: sourceRelationshipReviews.relationshipWasNewlyCreated,
    })
    .from(sourceRelationshipReviews)
    .innerJoin(adminDecisions, eq(adminDecisions.id, sourceRelationshipReviews.adminDecisionId))
    .where(eq(sourceRelationshipReviews.aiResultId, aiResultId));
  return rows;
}

/** Plain existence/title/url lookup for resolving fromSourceItemId/toSourceItemId -> display fields across a small batch of ids (at most one cluster's worth) for display. */
export async function listSourceItemsByIds(db: DbExecutor, ids: number[]): Promise<{ id: number; title: string | null; url: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: sourceItems.id, title: sourceItems.title, url: sourceItems.url }).from(sourceItems).where(inArray(sourceItems.id, ids));
}
