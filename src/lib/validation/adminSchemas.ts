import { z } from "zod";

const investigationStatuses = [
  "unverified",
  "corroborated",
  "strongly_corroborated",
  "confirmed",
  "disproven",
  "unresolvable",
] as const;

const developmentOutcomes = [
  "unknown",
  "reflected_in_development",
  "changed_during_development",
  "cut",
  "in_final_game",
  "not_applicable",
] as const;

const informationTypes = [
  "fact",
  "official",
  "report",
  "leak",
  "rumour",
  "speculation",
  "prediction",
  "interpretation",
] as const;

const claimRelationshipTypes = ["equivalent", "subsumes", "refines", "contradicts", "related"] as const;
const sourceRelationshipTypes = [
  "original",
  "independent_corroboration",
  "citation",
  "repetition",
  "aggregation",
  "derivative",
  "unknown",
] as const;
const stances = ["supports", "contradicts", "mentions"] as const;

export const slugSchema = z
  .string()
  .trim()
  .min(1, "Slug is required")
  .max(220)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase, alphanumeric, hyphen-separated");

export const createClaimSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  statement: z.string().trim().min(10, "Statement is too short").max(2000),
  slug: slugSchema,
  informationType: z.enum(informationTypes),
  firstReportedAt: z.coerce.date().optional(),
  topicIds: z.array(z.coerce.number().int().positive()).default([]),
  initialInvestigationStatus: z.enum(investigationStatuses).default("unverified"),
  initialDevelopmentOutcome: z.enum(developmentOutcomes).default("unknown"),
  reason: z.string().trim().min(5, "A brief reason for the initial status is required").max(1000),
});

export const updateClaimMetadataSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  statement: z.string().trim().min(10).max(2000),
  slug: slugSchema,
  informationType: z.enum(informationTypes),
  firstReportedAt: z.coerce.date().optional(),
  topicIds: z.array(z.coerce.number().int().positive()).default([]),
});

export const investigationTransitionSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  newStatus: z.enum(investigationStatuses),
  reason: z.string().trim().min(5, "A reason is required").max(1000),
  confidence: z.coerce.number().min(0).max(1).optional(),
  evidenceIds: z.array(z.coerce.number().int().positive()).default([]),
});

export const developmentTransitionSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  newOutcome: z.enum(developmentOutcomes),
  reason: z.string().trim().min(5, "A reason is required").max(1000),
  confidence: z.coerce.number().min(0).max(1).optional(),
  evidenceIds: z.array(z.coerce.number().int().positive()).default([]),
});

export const createTopicSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  slug: slugSchema,
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
});

export const createSourceSchema = z.object({
  name: z.string().trim().min(2).max(300),
  sourceTypeId: z.coerce.number().int().positive(),
  homepageUrl: z.string().trim().url().optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional(),
});

export const createSourceItemSchema = z.object({
  sourceId: z.coerce.number().int().positive(),
  itemTypeId: z.coerce.number().int().positive(),
  url: z.string().trim().url("Must be a valid URL"),
  canonicalUrl: z.string().trim().url().optional().or(z.literal("")),
  title: z.string().trim().max(500).optional(),
  author: z.string().trim().max(300).optional(),
  publishedAt: z.coerce.date().optional(),
  excerpt: z
    .string()
    .trim()
    .max(600, "Keep excerpts short -- this is not a place to store full article text")
    .optional(),
});

export const linkClaimSourceSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  sourceItemId: z.coerce.number().int().positive(),
  stance: z.enum(stances),
  supportingExcerpt: z.string().trim().max(600).optional(),
});

export const createEvidenceSchema = z.object({
  description: z.string().trim().min(5).max(2000),
  evidenceType: z.string().trim().min(2).max(100),
  sourceItemId: z.coerce.number().int().positive().optional(),
});

export const linkEvidenceToClaimSchema = z.object({
  evidenceId: z.coerce.number().int().positive(),
  claimId: z.coerce.number().int().positive(),
  stance: z.enum(stances),
});

export const createSourceRelationshipSchema = z
  .object({
    sourceItemIdA: z.coerce.number().int().positive(),
    sourceItemIdB: z.coerce.number().int().positive(),
    relationshipType: z.enum(sourceRelationshipTypes),
    confidence: z.coerce.number().min(0).max(1).optional(),
    evidenceNote: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.sourceItemIdA !== v.sourceItemIdB, {
    message: "A source item cannot have a relationship to itself",
    path: ["sourceItemIdB"],
  });

export const createClaimRelationshipSchema = z
  .object({
    claimIdA: z.coerce.number().int().positive(),
    claimIdB: z.coerce.number().int().positive(),
    relationshipType: z.enum(claimRelationshipTypes),
    confidence: z.coerce.number().min(0).max(1).optional(),
  })
  .refine((v) => v.claimIdA !== v.claimIdB, {
    message: "A claim cannot have a relationship to itself",
    path: ["claimIdB"],
  });

/* =========================================================================
 * INGESTION (Phase 4 PR 4 — manual ingestion pipeline core)
 * ========================================================================= */

/** Input to submitUrlForIngestion. Deliberately just the URL -- everything else (discoveryProvider=manual, initiatedBy=human, adminUserId) is derived server-side from the authenticated admin, never client-supplied. */
export const submitIngestionUrlSchema = z.object({
  url: z.string().trim().min(1, "A URL is required").url("Must be a valid absolute URL"),
});

/**
 * Input to finalizeIngestionConfirmation. `jobId` identifies the
 * `ready_for_confirmation` job being confirmed; the rest mirrors
 * createSourceItemSchema's fields, since finalization ultimately inserts
 * a `source_items` row -- but every field here is admin-supplied/
 * -editable at confirmation time (Section 12: nothing is auto-created
 * or auto-trusted merely because the pipeline extracted it). `itemTypeId`
 * has no automatic default -- classifying "article" vs "press_release"
 * vs "official_statement" etc. is a human judgment this PR does not
 * attempt to infer.
 */
export const confirmIngestionSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  sourceId: z.coerce.number().int().positive(),
  itemTypeId: z.coerce.number().int().positive(),
  title: z.string().trim().max(500).optional(),
  author: z.string().trim().max(300).optional(),
  publishedAt: z.coerce.date().optional(),
  excerpt: z
    .string()
    .trim()
    .max(600, "Keep excerpts short -- this is not a place to store full article text")
    .optional(),
  /**
   * PR 5 security condition: the actual retrieved URL, canonical URL,
   * excerpt fallback, and content hash are NOT accepted as raw form
   * fields here -- they travel only inside this signed, HMAC-verified
   * token (see reviewPayloadSigning.ts), so a tampered hidden field
   * can't substitute different review data than what the pipeline
   * actually fetched and hashed.
   */
  reviewToken: z.string().min(1, "Missing review token -- resubmit the URL to review it again"),
});
