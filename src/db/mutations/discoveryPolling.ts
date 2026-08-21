import "server-only";
import { and, eq, asc, sql } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { discoveryFeeds, ingestionJobs, discoveryProviders } from "@/db/schema";
import {
  DEFAULT_FEED_POLL_BATCH_SIZE,
  IN_PROGRESS_POLL_STATUS,
} from "@/lib/ingestion/discoveryPollingLifecycle";

/**
 * Phase 4 PR 10: DB access for the automated RSS/Atom discovery poller
 * (src/app/api/discovery/poll/route.ts). Deliberately its own module,
 * separate from src/db/mutations/ingestion.ts (the manual,
 * admin-request-driven mutation surface) and from
 * src/db/mutations/ingestionProcessor.ts (PR 9's automated job
 * processor) — this file is the one place that claims discovery_feeds
 * rows and creates system-initiated ingestion_jobs, with no preceding
 * requireAdmin() call, same boundary-auditability rationale as
 * ingestionProcessor.ts's own file header.
 */

// ---------------------------------------------------------------------------
// Phase A: claim due feeds
// ---------------------------------------------------------------------------

export interface ClaimedDiscoveryFeed {
  id: number;
  sourceId: number;
  feedUrl: string;
  pollingIntervalMinutes: number;
}

/**
 * Atomically claims up to `batchSize` due, enabled feeds using
 * `FOR UPDATE SKIP LOCKED` (same primitive PR 9 uses for ingestion_jobs
 * — if two invocations overlap, a feed row already locked by one is
 * simply skipped by the other rather than both polling it). Within the
 * SAME short transaction, immediately writes `last_polled_at = now()`
 * and `last_poll_status = 'polling'` (Locked Decision 1) as the durable
 * claim marker — a lock alone provides no protection once the
 * transaction holding it commits and releases it, so the write has to
 * land before that happens.
 *
 * Ordered oldest-`last_polled_at`-first (nulls first, i.e. never-polled
 * feeds get priority) so a backlog larger than one batch drains fairly
 * across runs rather than always favoring the same subset.
 *
 * Accepted trade-off (Locked Decision 1): if this invocation crashes
 * partway through processing a claimed batch, the unprocessed feeds in
 * that batch will already show as "just polled" and wait a full
 * interval before being reconsidered due. No last_poll_attempt_at /
 * stale-reclaim machinery is added for this in PR 10 — see the PR 10
 * plan for why this is proportionate at the project's current scale.
 */
export async function claimDueDiscoveryFeeds(
  now: Date = new Date(),
  batchSize: number = DEFAULT_FEED_POLL_BATCH_SIZE
): Promise<ClaimedDiscoveryFeed[]> {
  return adminDb.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: discoveryFeeds.id })
      .from(discoveryFeeds)
      .where(
        and(
          eq(discoveryFeeds.enabled, true),
          sql`(${discoveryFeeds.lastPolledAt} IS NULL OR ${discoveryFeeds.lastPolledAt} + (${discoveryFeeds.pollingIntervalMinutes} || ' minutes')::interval <= ${now})`
        )
      )
      .orderBy(asc(discoveryFeeds.lastPolledAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const claimed: ClaimedDiscoveryFeed[] = [];
    for (const candidate of candidates) {
      const [row] = await tx
        .update(discoveryFeeds)
        .set({ lastPolledAt: now, lastPollStatus: IN_PROGRESS_POLL_STATUS })
        .where(eq(discoveryFeeds.id, candidate.id))
        .returning({
          id: discoveryFeeds.id,
          sourceId: discoveryFeeds.sourceId,
          feedUrl: discoveryFeeds.feedUrl,
          pollingIntervalMinutes: discoveryFeeds.pollingIntervalMinutes,
        });
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

/** Small, separate update once a claimed feed's poll (success or handled failure) has actually finished — does not touch last_polled_at again, only the observability status string. */
export async function recordFeedPollOutcome(feedId: number, statusText: string): Promise<void> {
  await adminDb.update(discoveryFeeds).set({ lastPollStatus: statusText }).where(eq(discoveryFeeds.id, feedId));
}

// ---------------------------------------------------------------------------
// Phase B: system-discovered job creation
// ---------------------------------------------------------------------------

let cachedRssDiscoveryProviderId: number | null = null;

/** `discovery_providers` is tiny, seeded, effectively-static reference data — same caching rationale as ingestion.ts's getManualDiscoveryProviderId. */
async function getRssDiscoveryProviderId(): Promise<number> {
  if (cachedRssDiscoveryProviderId !== null) return cachedRssDiscoveryProviderId;
  const [row] = await adminDb
    .select({ id: discoveryProviders.id })
    .from(discoveryProviders)
    .where(eq(discoveryProviders.slug, "rss"))
    .limit(1);
  if (!row) {
    throw new Error("The 'rss' discovery provider is not seeded -- this is a data integrity problem, not a runtime error.");
  }
  cachedRssDiscoveryProviderId = row.id;
  return row.id;
}

/**
 * Postgres unique-violation SQLSTATE. Used to recognize the one error
 * this function is specifically designed to handle gracefully (Locked
 * Decision 3): a concurrent invocation won the race on
 * ingestion_jobs_discovery_feed_normalized_url_unique for this same
 * normalizedUrl between our pre-check and this insert.
 */
const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * drizzle-orm's node-postgres driver wraps every query error in a
 * DrizzleQueryError, whose `.cause` holds the real `pg` error (the one
 * with `.code`) -- verified empirically against this project's actual
 * error output, not assumed. Checks both the outer error and `.cause`
 * defensively, in case a raw pg error is ever thrown directly by a
 * different code path.
 */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  if (codeOf(err) === POSTGRES_UNIQUE_VIOLATION) return true;
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return codeOf(cause) === POSTGRES_UNIQUE_VIOLATION;
}

export type CreateSystemJobResult =
  | { outcome: "created"; jobId: number }
  | { outcome: "already_discovered" };

/**
 * Creates a system-discovered ingestion_job for one feed item URL, per
 * the locked dedupe design:
 *
 *   1. Application pre-check: does ANY ingestion_jobs row already exist
 *      for this normalizedUrl (manual OR system, any status)? If so,
 *      skip -- a human or an earlier poll already pushed this URL into
 *      the pipeline, and re-queuing it has no value (Locked Decision,
 *      final open question).
 *   2. Insert. The database's partial unique index
 *      (ingestion_jobs_discovery_feed_normalized_url_unique, scoped to
 *      discovery_feed_id IS NOT NULL) is the AUTHORITATIVE protection
 *      against a race between overlapping invocations -- if another
 *      poll run created a system job for this exact normalizedUrl
 *      between our pre-check and this insert, the insert raises a
 *      23505 unique violation, which is caught here and treated as
 *      "already discovered," never as a hard failure that would abort
 *      the rest of this feed's items.
 *
 * Manual ingestion semantics are entirely unaffected: this function
 * never touches a job with discovery_feed_id NULL, and the unique
 * index it relies on explicitly excludes those rows.
 */
export async function createSystemDiscoveredJob(params: {
  submittedUrl: string;
  normalizedUrl: string;
  discoveryFeedId: number;
}): Promise<CreateSystemJobResult> {
  const rssProviderId = await getRssDiscoveryProviderId();

  const [existing] = await adminDb
    .select({ id: ingestionJobs.id })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.normalizedUrl, params.normalizedUrl))
    .limit(1);
  if (existing) {
    return { outcome: "already_discovered" };
  }

  try {
    const [job] = await adminDb
      .insert(ingestionJobs)
      .values({
        submittedUrl: params.submittedUrl,
        normalizedUrl: params.normalizedUrl,
        discoveryProviderId: rssProviderId,
        discoveryFeedId: params.discoveryFeedId,
        initiatedBy: "system",
        adminUserId: null,
        status: "queued",
      })
      .returning({ id: ingestionJobs.id });
    return { outcome: "created", jobId: job!.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the race to a concurrent invocation -- not a failure, the
      // URL is now discovered either way. See file header.
      return { outcome: "already_discovered" };
    }
    throw err;
  }
}
