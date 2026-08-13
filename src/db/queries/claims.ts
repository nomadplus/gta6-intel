import "server-only";
import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../client";
import {
  claims,
  claimTopics,
  topics,
  investigationStatusEnum,
  developmentOutcomeEnum,
  informationTypeEnum,
} from "../schema";

export type InvestigationStatus = (typeof investigationStatusEnum.enumValues)[number];
export type DevelopmentOutcome = (typeof developmentOutcomeEnum.enumValues)[number];
export type InformationType = (typeof informationTypeEnum.enumValues)[number];

export type ClaimSummary = {
  id: number;
  slug: string;
  statement: string;
  informationType: InformationType;
  currentInvestigationStatus: InvestigationStatus;
  currentDevelopmentOutcome: DevelopmentOutcome;
  firstReportedAt: Date | null;
  topics: { slug: string; name: string }[];
};

export type ClaimFilters = {
  investigationStatus?: string;
  developmentOutcome?: string;
  informationType?: string;
  topicSlug?: string;
  q?: string;
};

/**
 * Claim ref parsing: URLs are /claims/{id}-{slug}. The numeric id (never
 * the slug text) is the real identifier, so a slug can be corrected later
 * without breaking any existing link. We only need the leading digits.
 */
export function parseClaimRef(ref: string): number | null {
  const match = /^(\d+)(?:-.*)?$/.exec(ref);
  if (!match) return null;
  return Number(match[1]);
}

export function claimHref(claim: { id: number; slug: string }): string {
  return `/claims/${claim.id}-${claim.slug}`;
}

async function attachTopics(rows: Omit<ClaimSummary, "topics">[]): Promise<ClaimSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const topicRows = await db
    .select({
      claimId: claimTopics.claimId,
      slug: topics.slug,
      name: topics.name,
    })
    .from(claimTopics)
    .innerJoin(topics, eq(topics.id, claimTopics.topicId))
    .where(inArray(claimTopics.claimId, ids));

  const byClaimId = new Map<number, { slug: string; name: string }[]>();
  for (const row of topicRows) {
    const list = byClaimId.get(row.claimId) ?? [];
    list.push({ slug: row.slug, name: row.name });
    byClaimId.set(row.claimId, list);
  }

  return rows.map((r) => ({ ...r, topics: byClaimId.get(r.id) ?? [] }));
}

export async function getClaims(filters: ClaimFilters = {}): Promise<ClaimSummary[]> {
  const conditions = [];

  if (filters.investigationStatus) {
    conditions.push(
      eq(claims.currentInvestigationStatus, filters.investigationStatus as InvestigationStatus)
    );
  }
  if (filters.developmentOutcome) {
    conditions.push(
      eq(claims.currentDevelopmentOutcome, filters.developmentOutcome as DevelopmentOutcome)
    );
  }
  if (filters.informationType) {
    conditions.push(eq(claims.informationType, filters.informationType as InformationType));
  }
  if (filters.q) {
    conditions.push(ilike(claims.statement, `%${filters.q}%`));
  }

  let claimIdsForTopic: number[] | null = null;
  if (filters.topicSlug) {
    const rows = await db
      .select({ claimId: claimTopics.claimId })
      .from(claimTopics)
      .innerJoin(topics, eq(topics.id, claimTopics.topicId))
      .where(eq(topics.slug, filters.topicSlug));
    claimIdsForTopic = rows.map((r) => r.claimId);
    if (claimIdsForTopic.length === 0) return [];
    conditions.push(inArray(claims.id, claimIdsForTopic));
  }

  const rows = await db
    .select({
      id: claims.id,
      slug: claims.slug,
      statement: claims.statement,
      informationType: claims.informationType,
      currentInvestigationStatus: claims.currentInvestigationStatus,
      currentDevelopmentOutcome: claims.currentDevelopmentOutcome,
      firstReportedAt: claims.firstReportedAt,
    })
    .from(claims)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(claims.firstReportedAt));

  return attachTopics(rows);
}

export async function searchClaims(query: string): Promise<ClaimSummary[]> {
  // Phase 2: plain server-side ILIKE search over the claim statement.
  // Deliberately isolated in its own function so a later phase can swap
  // the implementation for pgvector/embedding-based semantic search
  // without touching any calling code -- same signature, same return
  // shape, different internals.
  if (!query.trim()) return [];
  return getClaims({ q: query });
}

export async function getClaimByRef(ref: string): Promise<ClaimSummary | null> {
  const id = parseClaimRef(ref);
  if (id === null) return null;

  const rows = await db
    .select({
      id: claims.id,
      slug: claims.slug,
      statement: claims.statement,
      informationType: claims.informationType,
      currentInvestigationStatus: claims.currentInvestigationStatus,
      currentDevelopmentOutcome: claims.currentDevelopmentOutcome,
      firstReportedAt: claims.firstReportedAt,
    })
    .from(claims)
    .where(eq(claims.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const [full] = await attachTopics(rows);
  return full;
}

export async function getDisprovenClaims(): Promise<ClaimSummary[]> {
  return getClaims({ investigationStatus: "disproven" });
}

export async function getConfirmedClaims(): Promise<ClaimSummary[]> {
  return getClaims({ investigationStatus: "confirmed" });
}

/** A small, non-exhaustive set for homepage preview strips. */
export async function getNotableClaims(limit = 4): Promise<ClaimSummary[]> {
  const all = await getClaims();
  return all.slice(0, limit);
}
