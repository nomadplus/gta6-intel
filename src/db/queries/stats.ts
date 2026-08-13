import "server-only";
import { sql } from "drizzle-orm";
import { db } from "../client";

export type SiteStats = {
  totalClaims: number;
  confirmedClaims: number;
  disprovenClaims: number;
  unverifiedOrCorroborated: number;
  totalSources: number;
  totalSourceItems: number;
};

export async function getSiteStats(): Promise<SiteStats> {
  const result = await db.execute<{
    total_claims: number;
    confirmed_claims: number;
    disproven_claims: number;
    pending_claims: number;
    total_sources: number;
    total_source_items: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM claims)::int AS total_claims,
      (SELECT count(*) FROM claims WHERE current_investigation_status = 'confirmed')::int AS confirmed_claims,
      (SELECT count(*) FROM claims WHERE current_investigation_status = 'disproven')::int AS disproven_claims,
      (SELECT count(*) FROM claims WHERE current_investigation_status IN ('unverified','corroborated','strongly_corroborated'))::int AS pending_claims,
      (SELECT count(*) FROM sources)::int AS total_sources,
      (SELECT count(*) FROM source_items)::int AS total_source_items
  `);

  const r = result.rows[0];
  return {
    totalClaims: r.total_claims,
    confirmedClaims: r.confirmed_claims,
    disprovenClaims: r.disproven_claims,
    unverifiedOrCorroborated: r.pending_claims,
    totalSources: r.total_sources,
    totalSourceItems: r.total_source_items,
  };
}

export type ConfirmedWithTiming = {
  id: number;
  slug: string;
  statement: string;
  firstReportedAt: Date | null;
  confirmedAt: Date | null;
  daysToConfirm: number | null;
};

/**
 * Only claims where BOTH a first_reported_at and an actual "confirmed"
 * transition exist are given a computed duration. Phase 2 rule: never
 * manufacture a number from incomplete data -- claims missing either
 * timestamp are still listed, just without a duration figure.
 */
export async function getConfirmedWithTiming(): Promise<ConfirmedWithTiming[]> {
  const result = await db.execute<{
    id: number;
    slug: string;
    statement: string;
    first_reported_at: Date | null;
    confirmed_at: Date | null;
    days_to_confirm: number | null;
  }>(sql`
    SELECT
      c.id, c.slug, c.statement, c.first_reported_at,
      h.changed_at AS confirmed_at,
      CASE WHEN c.first_reported_at IS NOT NULL
        THEN EXTRACT(DAY FROM h.changed_at - c.first_reported_at)::int
        ELSE NULL
      END AS days_to_confirm
    FROM claims c
    JOIN LATERAL (
      SELECT changed_at FROM claim_investigation_status_history
      WHERE claim_id = c.id AND new_status = 'confirmed'
      ORDER BY changed_at ASC LIMIT 1
    ) h ON true
    WHERE c.current_investigation_status = 'confirmed'
    ORDER BY days_to_confirm DESC NULLS LAST
  `);

  return result.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    statement: r.statement,
    firstReportedAt: r.first_reported_at ? new Date(r.first_reported_at) : null,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
    daysToConfirm: r.days_to_confirm,
  }));
}
