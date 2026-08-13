import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "../client";
import { topics, claimTopics } from "../schema";
import { getClaims, type ClaimSummary } from "./claims";

export type TopicSummary = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  claimCount: number;
};

export async function getTopics(): Promise<TopicSummary[]> {
  const result = await db.execute<{
    id: number;
    slug: string;
    name: string;
    description: string | null;
    claim_count: number;
  }>(sql`
    SELECT t.id, t.slug, t.name, t.description, count(ct.claim_id)::int AS claim_count
    FROM topics t
    LEFT JOIN claim_topics ct ON ct.topic_id = t.id
    GROUP BY t.id, t.slug, t.name, t.description
    ORDER BY t.name
  `);

  return result.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    claimCount: r.claim_count,
  }));
}

export async function getTopicBySlug(slug: string): Promise<{ id: number; slug: string; name: string; description: string | null } | null> {
  const rows = await db.select().from(topics).where(eq(topics.slug, slug)).limit(1);
  if (rows.length === 0) return null;
  return rows[0];
}

export async function getTopicClaims(topicSlug: string): Promise<ClaimSummary[]> {
  return getClaims({ topicSlug });
}
