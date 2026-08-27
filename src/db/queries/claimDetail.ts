import "server-only";
import { eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../client";
import {
  claimSources,
  sourceItems,
  sources,
  sourceItemTypes,
  sourceRelationships,
  claimEvidence,
  evidence,
  claimRelationships,
  claims,
  type claimSourceStanceEnum,
} from "../schema";

export type TimelineAxis = "investigation" | "development_outcome";

export type TimelineEntry = {
  transitionId: number;
  axis: TimelineAxis;
  previousValue: string | null;
  newValue: string;
  changedAt: Date;
  reason: string;
  confidence: string | null;
  initiatedBy: "ai" | "human" | "system";
};

/**
 * Reads the combined claim_status_timeline VIEW created in migration 0002.
 * The view exists specifically so callers don't need to UNION the two
 * typed ledgers themselves -- it is read-only (see Phase 1 grants).
 */
export async function getClaimTimeline(claimId: number): Promise<TimelineEntry[]> {
  const result = await db.execute<{
    transition_id: number;
    axis: TimelineAxis;
    previous_value: string | null;
    new_value: string;
    changed_at: Date;
    reason: string;
    confidence: string | null;
    initiated_by: "ai" | "human" | "system";
  }>(sql`
    SELECT transition_id, axis, previous_value, new_value, changed_at, reason, confidence, initiated_by
    FROM claim_status_timeline
    WHERE claim_id = ${claimId}
    ORDER BY changed_at ASC
  `);

  return result.rows.map((r) => ({
    transitionId: r.transition_id,
    axis: r.axis,
    previousValue: r.previous_value,
    newValue: r.new_value,
    changedAt: new Date(r.changed_at),
    reason: r.reason,
    confidence: r.confidence,
    initiatedBy: r.initiated_by,
  }));
}

export type GlobalTimelineEntry = TimelineEntry & {
  claimId: number;
  claimSlug: string;
  claimStatement: string;
};

/** Site-wide chronological feed for /timeline, newest first. */
export async function getGlobalTimeline(limit = 100): Promise<GlobalTimelineEntry[]> {
  const result = await db.execute<{
    transition_id: number;
    axis: TimelineAxis;
    previous_value: string | null;
    new_value: string;
    changed_at: Date;
    reason: string;
    confidence: string | null;
    initiated_by: "ai" | "human" | "system";
    claim_id: number;
    claim_slug: string;
    claim_statement: string;
  }>(sql`
    SELECT t.transition_id, t.axis, t.previous_value, t.new_value, t.changed_at,
           t.reason, t.confidence, t.initiated_by,
           c.id AS claim_id, c.slug AS claim_slug, c.statement AS claim_statement
    FROM claim_status_timeline t
    JOIN claims c ON c.id = t.claim_id
    ORDER BY t.changed_at DESC
    LIMIT ${limit}
  `);

  return result.rows.map((r) => ({
    transitionId: r.transition_id,
    axis: r.axis,
    previousValue: r.previous_value,
    newValue: r.new_value,
    changedAt: new Date(r.changed_at),
    reason: r.reason,
    confidence: r.confidence,
    initiatedBy: r.initiated_by,
    claimId: r.claim_id,
    claimSlug: r.claim_slug,
    claimStatement: r.claim_statement,
  }));
}


export type ClaimSourceItem = {
  claimSourceId: number;
  stance: (typeof claimSourceStanceEnum.enumValues)[number];
  supportingExcerpt: string | null;
  sourceItemId: number;
  title: string | null;
  url: string;
  publishedAt: Date | null;
  itemTypeLabel: string;
  sourceName: string;
};

export async function getClaimSources(claimId: number): Promise<ClaimSourceItem[]> {
  const rows = await db
    .select({
      claimSourceId: claimSources.id,
      stance: claimSources.stance,
      supportingExcerpt: claimSources.supportingExcerpt,
      sourceItemId: sourceItems.id,
      title: sourceItems.title,
      url: sourceItems.url,
      publishedAt: sourceItems.publishedAt,
      itemTypeLabel: sourceItemTypes.label,
      sourceName: sources.name,
    })
    .from(claimSources)
    .innerJoin(sourceItems, eq(sourceItems.id, claimSources.sourceItemId))
    .innerJoin(sourceItemTypes, eq(sourceItemTypes.id, sourceItems.itemTypeId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(eq(claimSources.claimId, claimId))
    .orderBy(sourceItems.publishedAt);

  return rows;
}

export type ProvenanceLink = {
  fromTitle: string | null;
  fromUrl: string;
  toTitle: string | null;
  toUrl: string;
  relationshipType: string;
  confidence: string | null;
  evidenceNote: string | null;
};

/**
 * For every source item attached to this claim, find any recorded
 * relationship to another source item (citation, derivative, etc). This
 * is what lets the claim page say "these two articles are not independent"
 * instead of just listing four sources.
 */
export async function getClaimProvenanceChain(claimId: number): Promise<ProvenanceLink[]> {
  const attachedItemIds = await db
    .select({ id: claimSources.sourceItemId })
    .from(claimSources)
    .where(eq(claimSources.claimId, claimId));

  const ids = attachedItemIds.map((r) => r.id);
  if (ids.length === 0) return [];

  const fromItem = alias(sourceItems, "from_item");
  const toItem = alias(sourceItems, "to_item");

  const rows = await db
    .select({
      fromTitle: fromItem.title,
      fromUrl: fromItem.url,
      toTitle: toItem.title,
      toUrl: toItem.url,
      relationshipType: sourceRelationships.relationshipType,
      confidence: sourceRelationships.confidence,
      evidenceNote: sourceRelationships.evidenceNote,
    })
    .from(sourceRelationships)
    .innerJoin(fromItem, eq(fromItem.id, sourceRelationships.sourceItemIdA))
    .innerJoin(toItem, eq(toItem.id, sourceRelationships.sourceItemIdB))
    .where(
      or(
        inArray(sourceRelationships.sourceItemIdA, ids),
        inArray(sourceRelationships.sourceItemIdB, ids)
      )
    )
    .orderBy(sourceRelationships.id);

  return rows;
}

export type ClaimEvidenceItem = {
  evidenceId: number;
  description: string;
  evidenceType: string;
  stance: (typeof claimSourceStanceEnum.enumValues)[number];
  addedBy: "ai" | "human" | "system";
  sourceItemTitle: string | null;
  sourceItemUrl: string | null;
};

export async function getClaimEvidence(claimId: number): Promise<ClaimEvidenceItem[]> {
  const rows = await db
    .select({
      evidenceId: evidence.id,
      description: evidence.description,
      evidenceType: evidence.evidenceType,
      stance: claimEvidence.stance,
      addedBy: evidence.addedBy,
      sourceItemTitle: sourceItems.title,
      sourceItemUrl: sourceItems.url,
    })
    .from(claimEvidence)
    .innerJoin(evidence, eq(evidence.id, claimEvidence.evidenceId))
    .leftJoin(sourceItems, eq(sourceItems.id, evidence.sourceItemId))
    .where(eq(claimEvidence.claimId, claimId));

  return rows;
}

export type RelatedClaim = {
  id: number;
  slug: string;
  statement: string;
  relationshipType: string;
  confidence: string | null;
  /**
   * Phase 5 PR 7: whether the VIEWED claim (claimId, the argument to
   * getRelatedClaims) is stored as claim_relationships.claim_id_a for
   * this row. Required to render subsumes/refines correctly -- without
   * it, a directional relationship's meaning is ambiguous depending on
   * which side of the stored row the viewed claim happens to occupy.
   * See src/lib/relationshipDisplay.ts's relatedClaimLabel(), the single
   * place this flag is consumed.
   */
  viewedClaimIsA: boolean;
};

export async function getRelatedClaims(claimId: number): Promise<RelatedClaim[]> {
  const result = await db.execute<{
    id: number;
    slug: string;
    statement: string;
    relationship_type: string;
    confidence: string | null;
    viewed_claim_is_a: boolean;
  }>(sql`
    SELECT c.id, c.slug, c.statement, cr.relationship_type, cr.confidence,
           (cr.claim_id_a = ${claimId}) AS viewed_claim_is_a
    FROM claim_relationships cr
    JOIN claims c ON c.id = CASE WHEN cr.claim_id_a = ${claimId} THEN cr.claim_id_b ELSE cr.claim_id_a END
    WHERE cr.claim_id_a = ${claimId} OR cr.claim_id_b = ${claimId}
    ORDER BY cr.id
  `);

  return result.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    statement: r.statement,
    relationshipType: r.relationship_type,
    confidence: r.confidence,
    viewedClaimIsA: r.viewed_claim_is_a,
  }));
}
