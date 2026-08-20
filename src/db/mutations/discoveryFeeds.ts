import "server-only";
import { eq } from "drizzle-orm";
import { discoveryFeeds } from "@/db/schema";
import { withAuditedTransaction, logAdminAction } from "./shared";
import { createDiscoveryFeedSchema, updateDiscoveryFeedSchema } from "@/lib/validation/adminSchemas";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { normalizeUrl } from "@/lib/ingestion/urlNormalization";

/**
 * Thrown when the submitted feed URL fails normalizeUrl() -- unsupported
 * scheme, embedded credentials, or otherwise malformed. Reuses the same
 * normalization pass ingestion already depends on (src/lib/ingestion/
 * urlNormalization.ts) rather than re-validating URLs with separate logic
 * here; see migration 0011's file header for why this table stores only
 * the normalized form.
 */
export class InvalidFeedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFeedUrlError";
  }
}

/**
 * Normalizes the submitted feed URL and throws InvalidFeedUrlError if it
 * doesn't pass normalizeUrl() -- shared by create and update so both
 * paths reject the same malformed input the same way.
 */
function normalizeFeedUrlOrThrow(rawFeedUrl: string): string {
  const normalized = normalizeUrl(rawFeedUrl);
  if (!normalized.ok) {
    throw new InvalidFeedUrlError(normalized.error.message);
  }
  return normalized.normalizedUrl;
}

export async function createDiscoveryFeed(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = createDiscoveryFeedSchema.parse(input);
  const normalizedFeedUrl = normalizeFeedUrlOrThrow(data.feedUrl);

  return withAuditedTransaction(async (tx) => {
    const [feed] = await tx
      .insert(discoveryFeeds)
      .values({
        sourceId: data.sourceId,
        feedUrl: normalizedFeedUrl,
        enabled: data.enabled,
        pollingIntervalMinutes: data.pollingIntervalMinutes,
      })
      .returning();

    await logAdminAction(tx, admin, {
      action: "create",
      entityType: "discovery_feed",
      entityId: feed.id,
      summary: `Registered discovery feed: ${normalizedFeedUrl}`,
    });

    return feed;
  });
}

export async function updateDiscoveryFeed(input: unknown) {
  const admin = await requireAdmin("editor");
  const data = updateDiscoveryFeedSchema.parse(input);
  const normalizedFeedUrl = normalizeFeedUrlOrThrow(data.feedUrl);

  return withAuditedTransaction(async (tx) => {
    const [updated] = await tx
      .update(discoveryFeeds)
      .set({
        sourceId: data.sourceId,
        feedUrl: normalizedFeedUrl,
        enabled: data.enabled,
        pollingIntervalMinutes: data.pollingIntervalMinutes,
      })
      .where(eq(discoveryFeeds.id, data.feedId))
      .returning();

    await logAdminAction(tx, admin, {
      action: "update",
      entityType: "discovery_feed",
      entityId: data.feedId,
      summary: `Updated discovery feed #${data.feedId} (${data.enabled ? "enabled" : "disabled"})`,
    });

    return updated;
  });
}
