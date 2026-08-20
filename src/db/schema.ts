import {
  pgTable,
  pgEnum,
  serial,
  text,
  varchar,
  timestamp,
  numeric,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* =========================================================================
 * ENUMS
 * ========================================================================= */

// Axis 1: how well-evidenced the claim itself is, independent of what shipped
export const investigationStatusEnum = pgEnum("investigation_status", [
  "unverified",
  "corroborated",
  "strongly_corroborated",
  "confirmed",
  "disproven",
  "unresolvable",
]);

// Axis 2: what actually happened in the game, independent of report quality
export const developmentOutcomeEnum = pgEnum("development_outcome", [
  "unknown",
  "reflected_in_development",
  "changed_during_development",
  "cut",
  "in_final_game",
  "not_applicable",
]);

export const informationTypeEnum = pgEnum("information_type", [
  "fact",
  "official",
  "report",
  "leak",
  "rumour",
  "speculation",
  "prediction",
  "interpretation",
]);

export const claimRelationshipTypeEnum = pgEnum("claim_relationship_type", [
  "equivalent",
  "subsumes",
  "refines",
  "contradicts",
  "related",
]);

export const sourceRelationshipTypeEnum = pgEnum("source_relationship_type", [
  "original",
  "independent_corroboration",
  "citation",
  "repetition",
  "aggregation",
  "derivative",
  "unknown",
]);

export const claimSourceStanceEnum = pgEnum("claim_source_stance", [
  "supports",
  "contradicts",
  "mentions",
]);

export const initiatedByEnum = pgEnum("initiated_by", ["ai", "human", "system"]);

export const adminDecisionActionEnum = pgEnum("admin_decision_action", [
  "approve",
  "reject",
  "edit",
  "request_reanalysis",
  "direct_change",
]);

export const aiOperationEnum = pgEnum("ai_operation", [
  "classify_relevance",
  "extract_claims",
  "compare_claims",
  "analyse_provenance",
  "evaluate_evidence",
  "recommend_status",
  "embed",
]);

export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

// Where one ingestion/discovery attempt currently stands. Unlike
// discoveryProviders below (an open-ended, growing taxonomy of HOW an item
// was discovered), this is a small, fixed pipeline vocabulary -- the same
// reasoning that keeps investigationStatus/developmentOutcome as enums
// rather than lookup tables (see comment below). No statuses are added
// speculatively; each one corresponds to a real terminal or in-progress
// state the future ingestion pipeline will actually produce.
export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "queued",
  "fetching",
  "stored",
  "duplicate",
  "needs_review",
  "blocked_by_policy",
  "robots_disallowed",
  "authentication_required",
  "paywalled",
  "unsupported",
  "fetch_failed",
  "rate_limited",
  "malformed",
]);

/*
 * source_type and source_item_type are intentionally NOT enums.
 *
 * Unlike investigation_status / development_outcome — small, tightly
 * controlled domain vocabularies that define core business logic — these
 * are open-ended descriptive taxonomies expected to grow (podcast,
 * livestream, trailer, screenshot, archived_page, deleted_post,
 * investor_document, earnings_call, store_listing, community_post, ...).
 * They are modeled as lookup tables (below, near `sources`/`source_items`)
 * so new categories are a data insert, not a schema migration.
 */

/* =========================================================================
 * SUBJECT / PROJECT
 * ========================================================================= */

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(), // e.g. "gta-vi"
  name: varchar("name", { length: 200 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* =========================================================================
 * TOPICS
 * ========================================================================= */

export const topics = pgTable(
  "topics",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull().references(() => projects.id),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSlugUnique: uniqueIndex("topics_project_slug_unique").on(t.projectId, t.slug),
  })
);

/* =========================================================================
 * ADMIN USERS
 * ========================================================================= */

// Application-level permission tier. Deliberately NOT mirrored as separate
// Postgres roles -- see Phase 3 architecture note in the migration file.
export const adminRoleEnum = pgEnum("admin_role", [
  "owner",
  "editor",
  "reviewer",
  "read_only_analyst",
]);

export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  // Links to the Supabase Auth user (auth.users.id). Nullable so a seeded
  // admin can exist before being linked to a real auth identity.
  authUserId: varchar("auth_user_id", { length: 64 }).unique(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  role: adminRoleEnum("role").notNull().default("read_only_analyst"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* =========================================================================
 * ADMIN AUDIT LOG (append-only, same pattern as the Phase 1 status ledgers)
 * ========================================================================= */

export const adminAuditActionEnum = pgEnum("admin_audit_action", [
  "create",
  "update",
  "link",
  "unlink",
  "transition",
  "delete",
]);

export const adminAuditEntityTypeEnum = pgEnum("admin_audit_entity_type", [
  "claim",
  "source",
  "source_item",
  "evidence",
  "topic",
  "claim_source",
  "claim_evidence",
  "claim_topic",
  "claim_relationship",
  "source_relationship",
  "investigation_status_history",
  "development_outcome_history",
  // Added in migration 0008 (Phase 4 PR 6) -- closes the gap flagged in
  // src/db/mutations/ingestion.ts during PR 4 planning, where ingestion
  // job creation/completion had no audit_log entity type to log against.
  "ingestion_job",
]);

export const adminAuditLog = pgTable("admin_audit_log", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id").notNull().references(() => adminUsers.id),
  action: adminAuditActionEnum("action").notNull(),
  entityType: adminAuditEntityTypeEnum("entity_type").notNull(),
  entityId: integer("entity_id"),
  summary: text("summary").notNull(),
  // Structured context only (e.g. changed fields) -- never session/auth data.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* =========================================================================
 * SOURCE TAXONOMY (lookup tables — see comment above near the removed
 * source_type / source_item_type enums for why these aren't enums)
 * ========================================================================= */

export const sourceTypes = pgTable("source_types", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 200 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceItemTypes = pgTable("source_item_types", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 200 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* =========================================================================
 * SOURCES + SOURCE ITEMS
 * ========================================================================= */

export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 300 }).notNull(),
  sourceTypeId: integer("source_type_id").notNull().references(() => sourceTypes.id),
  homepageUrl: text("homepage_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceItems = pgTable(
  "source_items",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id").notNull().references(() => sources.id),
    itemTypeId: integer("item_type_id").notNull().references(() => sourceItemTypes.id),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url"),
    // Normalized form of `url`, written by future ingestion code.
    // Deliberately indexed but NOT unique: publishers reuse URLs (a
    // canonical URL's content can change after publication), so "same
    // normalized URL" cannot mean "same item" at the schema level. Future
    // ingestion logic distinguishes same-URL-same-hash (duplicate) from
    // same-URL-different-hash (needs_review) using rawContentHash below.
    normalizedUrl: text("normalized_url"),
    title: text("title"),
    author: varchar("author", { length: 300 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    // Short, legally-safe excerpt only — never full-article storage.
    excerpt: text("excerpt"),
    rawContentHash: varchar("raw_content_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    urlIdx: index("source_items_url_idx").on(t.url),
    hashIdx: index("source_items_hash_idx").on(t.rawContentHash),
    normalizedUrlIdx: index("source_items_normalized_url_idx").on(t.normalizedUrl),
  })
);

// Relationship between two SOURCE ITEMS (propagation / provenance graph)
export const sourceRelationships = pgTable(
  "source_relationships",
  {
    id: serial("id").primaryKey(),
    sourceItemIdA: integer("source_item_id_a").notNull().references(() => sourceItems.id),
    sourceItemIdB: integer("source_item_id_b").notNull().references(() => sourceItems.id),
    relationshipType: sourceRelationshipTypeEnum("relationship_type").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    evidenceNote: text("evidence_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairIdx: index("source_relationships_pair_idx").on(t.sourceItemIdA, t.sourceItemIdB),
    // Provenance relationships are inherently directional (citation,
    // derivative, repetition, etc all have a clear "from/to"), so unlike
    // claim_relationships this only guards against a literal duplicate row
    // and a self-link -- no symmetric-pair canonicalization here.
    noSelfLink: check("source_relationships_no_self_link", sql`${t.sourceItemIdA} <> ${t.sourceItemIdB}`),
    noDuplicate: uniqueIndex("source_relationships_no_duplicate").on(
      t.sourceItemIdA,
      t.sourceItemIdB,
      t.relationshipType
    ),
  })
);

/* =========================================================================
 * DISCOVERY / INGESTION (Phase 4 PR 1 — schema foundation only)
 *
 * This is the pipeline that will eventually populate `sourceItems`, kept
 * distinct from the concepts it feeds:
 *   - discovery: HOW an item was found (discoveryProviders / ingestionJobs
 *     here) — a pipeline/operational concern.
 *   - provenance: HOW a source item relates to other reporting
 *     (sourceRelationships above) — an epistemic concern, orthogonal to
 *     discovery. An item discovered manually can still be a citation of
 *     something an RSS feed found first, and vice versa.
 *   - truth: whether a claim built from that item is actually
 *     well-evidenced (investigationStatus / developmentOutcome on
 *     `claims`) — a human/AI-reviewed judgment, never inferred from how or
 *     how many times something was discovered.
 *
 * No fetching, normalization, retry, scheduling, or AI logic exists yet —
 * only the tables/columns later Phase 4 PRs will read and write.
 * ========================================================================= */

// Open-ended taxonomy of HOW an item was discovered — same lookup-table
// pattern as sourceTypes/sourceItemTypes above, for the same reason
// (expected to grow: manual, rss, and eventually things like an X/Twitter
// integration, which is deliberately not added yet).
export const discoveryProviders = pgTable("discovery_providers", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 200 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per ingestion/discovery attempt.
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: serial("id").primaryKey(),
    submittedUrl: text("submitted_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    discoveryProviderId: integer("discovery_provider_id")
      .notNull()
      .references(() => discoveryProviders.id),
    initiatedBy: initiatedByEnum("initiated_by").notNull(),
    adminUserId: integer("admin_user_id").references(() => adminUsers.id),
    status: ingestionStatusEnum("status").notNull().default("queued"),
    httpStatus: integer("http_status"),
    contentType: varchar("content_type", { length: 200 }),
    contentLength: integer("content_length"),
    attemptCount: integer("attempt_count").notNull().default(0),
    // Separate from createdAt (queue time) — the actual moment a fetch
    // attempt began. Future per-domain rate limiting needs real
    // fetch-attempt timing, not queue timing. Not used by any logic yet.
    startedAt: timestamp("started_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    sourceItemId: integer("source_item_id").references(() => sourceItems.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    // Shaped for the approved future in-flight-redundancy rule ("reuse a
    // job with the same normalizedUrl if one is already queued/fetching
    // and under an hour old") — not enforced here, no uniqueness
    // constraint, just an index matching that future query. Partial on
    // status so the index stays small as jobs settle into a terminal
    // status. The 1-hour cutoff is application logic and intentionally
    // not baked into the index definition.
    inflightLookupIdx: index("ingestion_jobs_inflight_lookup_idx")
      .on(t.normalizedUrl, t.createdAt)
      .where(sql`${t.status} IN ('queued', 'fetching')`),
  })
);

/* =========================================================================
 * CLAIMS
 * ========================================================================= */

export const claims = pgTable(
  "claims",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull().references(() => projects.id),
    // Cosmetic/SEO identifier only. The numeric id remains the real
    // identifier everywhere (FKs, internal lookups); slug editing must
    // never break a link, which is why routes resolve by leading id
    // (see Phase 2 URL design: /claims/{id}-{slug}).
    slug: varchar("slug", { length: 220 }).notNull(),
    statement: text("statement").notNull(),
    informationType: informationTypeEnum("information_type").notNull(),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }),

    // Denormalized read caches. These are NEVER written directly by
    // application code — they are kept in sync exclusively by the
    // sync_current_status_* triggers defined in migration 0002, fired
    // AFTER INSERT on the two history tables below.
    currentInvestigationStatus: investigationStatusEnum("current_investigation_status")
      .notNull()
      .default("unverified"),
    currentInvestigationStatusSince: timestamp("current_investigation_status_since", {
      withTimezone: true,
    }),
    currentDevelopmentOutcome: developmentOutcomeEnum("current_development_outcome")
      .notNull()
      .default("unknown"),
    currentDevelopmentOutcomeSince: timestamp("current_development_outcome_since", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index("claims_project_idx").on(t.projectId),
    invStatusIdx: index("claims_inv_status_idx").on(t.currentInvestigationStatus),
    devOutcomeIdx: index("claims_dev_outcome_idx").on(t.currentDevelopmentOutcome),
    slugIdx: uniqueIndex("claims_slug_unique").on(t.slug),
  })
);

export const claimTopics = pgTable(
  "claim_topics",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id").notNull().references(() => claims.id),
    topicId: integer("topic_id").notNull().references(() => topics.id),
  },
  (t) => ({
    claimTopicUnique: uniqueIndex("claim_topics_unique").on(t.claimId, t.topicId),
  })
);

// Relationship between two CLAIMS (the "not a giant duplicate flag" graph)
//
// Symmetric types (equivalent, related, contradicts) are canonicalized at
// write time -- claim_id_a is always the lower numeric id -- so "A
// equivalent B" and "B equivalent A" collapse into the same row
// deterministically, without a race-prone check-then-insert. Directional
// types (subsumes, refines) are stored exactly as submitted; no
// canonicalization, since direction is the meaningful part. See
// src/db/mutations/claimRelationships.ts for the canonicalization logic.
export const claimRelationships = pgTable(
  "claim_relationships",
  {
    id: serial("id").primaryKey(),
    claimIdA: integer("claim_id_a").notNull().references(() => claims.id),
    claimIdB: integer("claim_id_b").notNull().references(() => claims.id),
    relationshipType: claimRelationshipTypeEnum("relationship_type").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdBy: initiatedByEnum("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairIdx: index("claim_relationships_pair_idx").on(t.claimIdA, t.claimIdB),
    noSelfLink: check("claim_relationships_no_self_link", sql`${t.claimIdA} <> ${t.claimIdB}`),
    noDuplicate: uniqueIndex("claim_relationships_no_duplicate").on(
      t.claimIdA,
      t.claimIdB,
      t.relationshipType
    ),
  })
);

// Join: which source items support/mention/contradict which claim
export const claimSources = pgTable(
  "claim_sources",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id").notNull().references(() => claims.id),
    sourceItemId: integer("source_item_id").notNull().references(() => sourceItems.id),
    stance: claimSourceStanceEnum("stance").notNull(),
    supportingExcerpt: text("supporting_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    claimSourceUnique: uniqueIndex("claim_sources_unique").on(t.claimId, t.sourceItemId),
  })
);

/* =========================================================================
 * EVIDENCE
 *
 * Deliberately has NO direct claim_id. Evidence is extracted/discovered
 * from a source item first and may exist, validly, before it has been
 * matched to any claim — and one piece of evidence may end up supporting
 * or contradicting more than one claim (e.g. a single leaked build clip
 * can be evidence for both a "setting" claim and a "protagonist" claim).
 * The claim_evidence join table below is the many-to-many link; evidence
 * with zero rows there is simply unlinked, awaiting review — not an
 * invalid state.
 * ========================================================================= */

export const evidence = pgTable("evidence", {
  id: serial("id").primaryKey(),
  sourceItemId: integer("source_item_id").references(() => sourceItems.id),
  description: text("description").notNull(),
  evidenceType: varchar("evidence_type", { length: 100 }).notNull(),
  addedBy: initiatedByEnum("added_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Many-to-many: which claim(s) this evidence bears on, and how.
export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id").notNull().references(() => claims.id),
    evidenceId: integer("evidence_id").notNull().references(() => evidence.id),
    stance: claimSourceStanceEnum("stance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    claimEvidenceUnique: uniqueIndex("claim_evidence_unique").on(t.claimId, t.evidenceId),
  })
);

/* =========================================================================
 * AI + ADMIN AUDIT TRAIL
 * ========================================================================= */

export const aiJobs = pgTable("ai_jobs", {
  id: serial("id").primaryKey(),
  operation: aiOperationEnum("operation").notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  status: aiJobStatusEnum("status").notNull().default("pending"),
  inputRef: text("input_ref"), // free-text description/pointer of what was analyzed
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costEstimateUsd: numeric("cost_estimate_usd", { precision: 10, scale: 6 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiResults = pgTable("ai_results", {
  id: serial("id").primaryKey(),
  aiJobId: integer("ai_job_id").notNull().references(() => aiJobs.id),
  claimId: integer("claim_id").references(() => claims.id),
  structuredOutput: jsonb("structured_output").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  reasoning: text("reasoning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminDecisions = pgTable("admin_decisions", {
  id: serial("id").primaryKey(),
  aiResultId: integer("ai_result_id").references(() => aiResults.id), // null for direct human actions
  adminUserId: integer("admin_user_id").notNull().references(() => adminUsers.id),
  action: adminDecisionActionEnum("action").notNull(),
  notes: text("notes"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});

/* =========================================================================
 * STATUS HISTORY — the two append-only, immutable ledgers.
 *
 * IMPORTANT: rows here represent transitions that genuinely became
 * effective. A rejected AI proposal is recorded fully in ai_results +
 * admin_decisions (action = 'reject') and MUST NOT produce a row in
 * either of these tables. See migration 0002 for the INSERT-only grants
 * and immutability triggers that enforce this at the database level.
 * ========================================================================= */

export const claimInvestigationStatusHistory = pgTable(
  "claim_investigation_status_history",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id").notNull().references(() => claims.id),
    previousStatus: investigationStatusEnum("previous_status"), // null on first row
    newStatus: investigationStatusEnum("new_status").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    initiatedBy: initiatedByEnum("initiated_by").notNull(),
    aiResultId: integer("ai_result_id").references(() => aiResults.id),
    adminDecisionId: integer("admin_decision_id").references(() => adminDecisions.id),
  },
  (t) => ({
    claimIdx: index("inv_status_history_claim_idx").on(t.claimId, t.changedAt),
  })
);

export const claimDevelopmentOutcomeHistory = pgTable(
  "claim_development_outcome_history",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id").notNull().references(() => claims.id),
    previousOutcome: developmentOutcomeEnum("previous_outcome"), // null on first row
    newOutcome: developmentOutcomeEnum("new_outcome").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    initiatedBy: initiatedByEnum("initiated_by").notNull(),
    aiResultId: integer("ai_result_id").references(() => aiResults.id),
    adminDecisionId: integer("admin_decision_id").references(() => adminDecisions.id),
  },
  (t) => ({
    claimIdx: index("dev_outcome_history_claim_idx").on(t.claimId, t.changedAt),
  })
);

// Join tables linking a specific effective transition to supporting evidence
export const investigationTransitionEvidence = pgTable(
  "investigation_transition_evidence",
  {
    id: serial("id").primaryKey(),
    transitionId: integer("transition_id")
      .notNull()
      .references(() => claimInvestigationStatusHistory.id),
    evidenceId: integer("evidence_id").notNull().references(() => evidence.id),
  },
  (t) => ({
    unique: uniqueIndex("inv_transition_evidence_unique").on(t.transitionId, t.evidenceId),
  })
);

export const developmentTransitionEvidence = pgTable(
  "development_transition_evidence",
  {
    id: serial("id").primaryKey(),
    transitionId: integer("transition_id")
      .notNull()
      .references(() => claimDevelopmentOutcomeHistory.id),
    evidenceId: integer("evidence_id").notNull().references(() => evidence.id),
  },
  (t) => ({
    unique: uniqueIndex("dev_transition_evidence_unique").on(t.transitionId, t.evidenceId),
  })
);
