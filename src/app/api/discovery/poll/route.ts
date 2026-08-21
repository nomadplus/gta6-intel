import "server-only";
import { NextResponse } from "next/server";
import { requireCronSecret, MissingCronSecretConfigError, UnauthorizedCronRequestError } from "@/lib/auth/requireCronSecret";
import {
  claimDueDiscoveryFeeds,
  recordFeedPollOutcome,
  createSystemDiscoveredJob,
  type ClaimedDiscoveryFeed,
} from "@/db/mutations/discoveryPolling";
import { safeFetch } from "@/lib/ingestion/safeFetch";
import { parseFeed } from "@/lib/ingestion/feedParsing";
import { normalizeUrl } from "@/lib/ingestion/urlNormalization";

/**
 * Phase 4 PR 10: automated RSS/Atom discovery poller.
 *
 * Deliberately a SEPARATE route/cron entry from PR 9's
 * /api/ingestion/process, not a phase added to it (Locked Decision 5).
 * Two independent reasons:
 *
 *   1. Time-budget contention: PR 9's existing batch (5 jobs x up to 45s
 *      worst case each) can already use ~225s of the 300s Fluid Compute
 *      budget. Adding feed fetches (also up to 45s each) into the same
 *      invocation risked exceeding the limit on a bad day.
 *   2. PR 9's claim query (claimEligibleIngestionJobsForProcessing) only
 *      treats a 'queued' job as eligible once it is older than
 *      RECOVERY_STALE_THRESHOLD_MS (5 minutes) -- a job created moments
 *      earlier in the SAME invocation would fail that check and sit
 *      untouched for a full extra day. Scheduling this route at 04:00
 *      UTC and leaving PR 9's processor at 06:00 UTC (a two-hour gap,
 *      not one) comfortably clears that threshold even under Vercel
 *      Hobby's "anywhere within the scheduled hour" timing imprecision,
 *      with zero changes to PR 9's existing, working claim logic.
 *
 * This route only ever creates ingestion_jobs (status='queued') -- it
 * never fetches an article page, never runs duplicate detection against
 * source_items, and never touches anything PR 9's processor owns. That
 * separation of concerns is deliberate, not an oversight: "discovery"
 * (this route) and "processing" (PR 9's route) are independently
 * replaceable stages.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface FeedOutcomeSummary {
  feedId: number;
  feedUrl: string;
  status: string;
  itemsFound: number;
  jobsCreated: number;
  alreadyDiscovered: number;
  malformedSkipped: number;
}

/** Turns a safeFetch failure into the short status string recorded on discovery_feeds.last_poll_status -- reuses safeFetch's own error-code vocabulary rather than inventing a new one. */
function fetchFailureStatus(code: string): string {
  return `error: ${code}`;
}

async function pollOneFeed(feed: ClaimedDiscoveryFeed): Promise<FeedOutcomeSummary> {
  const fetchResult = await safeFetch(feed.feedUrl);

  if (!fetchResult.ok) {
    const status = fetchFailureStatus(fetchResult.error.code);
    await recordFeedPollOutcome(feed.id, status);
    return {
      feedId: feed.id,
      feedUrl: feed.feedUrl,
      status,
      itemsFound: 0,
      jobsCreated: 0,
      alreadyDiscovered: 0,
      malformedSkipped: 0,
    };
  }

  const parsed = parseFeed(fetchResult.bodyText);
  if (!parsed.ok) {
    const status = `error: ${parsed.error.code}`;
    await recordFeedPollOutcome(feed.id, status);
    return {
      feedId: feed.id,
      feedUrl: feed.feedUrl,
      status,
      itemsFound: 0,
      jobsCreated: 0,
      alreadyDiscovered: 0,
      malformedSkipped: 0,
    };
  }

  let jobsCreated = 0;
  let alreadyDiscovered = 0;
  let malformedSkipped = 0;

  // Sequential, not parallel -- matches PR 9's own reasoning: keeps this
  // feed's total time easy to reason about, and avoids many concurrent
  // writes racing each other pointlessly within the SAME invocation
  // (the partial unique index still protects correctness either way,
  // but there is no benefit to inviting avoidable 23505s from our own
  // single process).
  for (const item of parsed.items) {
    const normalized = normalizeUrl(item.rawUrl);
    if (!normalized.ok) {
      malformedSkipped += 1;
      continue;
    }

    const result = await createSystemDiscoveredJob({
      submittedUrl: item.rawUrl,
      normalizedUrl: normalized.normalizedUrl,
      discoveryFeedId: feed.id,
    });

    if (result.outcome === "created") {
      jobsCreated += 1;
    } else {
      alreadyDiscovered += 1;
    }
  }

  const status = `ok: ${parsed.items.length} items, ${jobsCreated} new, ${alreadyDiscovered} already discovered`;
  await recordFeedPollOutcome(feed.id, status);

  return {
    feedId: feed.id,
    feedUrl: feed.feedUrl,
    status,
    itemsFound: parsed.items.length,
    jobsCreated,
    alreadyDiscovered,
    malformedSkipped,
  };
}

async function runPoller(): Promise<{
  startedAt: string;
  durationMs: number;
  claimedCount: number;
  outcomes: FeedOutcomeSummary[];
}> {
  const startedAt = new Date();

  const claimed = await claimDueDiscoveryFeeds(startedAt);

  const outcomes: FeedOutcomeSummary[] = [];
  for (const feed of claimed) {
    try {
      outcomes.push(await pollOneFeed(feed));
    } catch (err) {
      // Same reasoning as PR 9's route: pollOneFeed is expected to
      // handle every ordinary failure itself via the typed
      // safeFetch/parseFeed result shapes. Reaching here means something
      // genuinely unexpected happened. The feed must not be left
      // showing 'polling' indefinitely, so its status is explicitly
      // finalized right now. The real error is logged server-side only.
      console.error(`[discovery-poller] feed ${feed.id} threw unexpectedly:`, err);
      await recordFeedPollOutcome(feed.id, "error: unexpected_error");
      outcomes.push({
        feedId: feed.id,
        feedUrl: feed.feedUrl,
        status: "error: unexpected_error",
        itemsFound: 0,
        jobsCreated: 0,
        alreadyDiscovered: 0,
        malformedSkipped: 0,
      });
    }
  }

  const durationMs = Date.now() - startedAt.getTime();

  return { startedAt: startedAt.toISOString(), durationMs, claimedCount: claimed.length, outcomes };
}

async function handle(request: Request): Promise<Response> {
  try {
    requireCronSecret(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof MissingCronSecretConfigError) {
      console.error("[discovery-poller]", err.message);
      return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });
    }
    if (err instanceof UnauthorizedCronRequestError) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    throw err;
  }

  const summary = await runPoller();

  console.log(`[discovery-poller] ${JSON.stringify(summary)}`);

  return NextResponse.json(summary, { status: 200 });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
