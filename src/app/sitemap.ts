import type { MetadataRoute } from "next";
import { getClaims, claimHref } from "@/db/queries/claims";
import { getTopics } from "@/db/queries/topics";
import { SITE_URL as BASE_URL } from "@/lib/siteConfig";

// Render fresh on every request so new claims/topics appear without a redeploy.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [claims, topics] = await Promise.all([getClaims(), getTopics()]);

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: "daily", priority: 1 },
    { url: `${BASE_URL}/claims`, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE_URL}/timeline`, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE_URL}/topics`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${BASE_URL}/graveyard`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${BASE_URL}/confirmed`, changeFrequency: "weekly", priority: 0.6 },
  ];

  const claimRoutes: MetadataRoute.Sitemap = claims.map((c) => ({
    url: `${BASE_URL}${claimHref(c)}`,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const topicRoutes: MetadataRoute.Sitemap = topics.map((t) => ({
    url: `${BASE_URL}/topics/${t.slug}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [...staticRoutes, ...claimRoutes, ...topicRoutes];
}
