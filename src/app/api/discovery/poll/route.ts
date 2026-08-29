import "server-only";
import { NextResponse } from "next/server";
import { requireCronSecret, MissingCronSecretConfigError, UnauthorizedCronRequestError } from "@/lib/auth/requireCronSecret";
import {
  claimDueDiscoveryFeeds,
  recordFeedPollOutcome,
  getRssDiscoveryProviderId,
  type ClaimedDiscoveryFeed,
} from "@/db/mutations/discoveryPolling";
import {
  recordDiscoverySighting,
  claimEligibleCandidatesForPromotionByIds,
  claimEligibleCandidatesForPromotion,
} from "@/db/mutations/discoveryCandidates";
import { safeFetch } from "@/lib/ingestion/safeFetch";
import { parseFeed } from "@/lib/ingestion/feedParsing";
import { RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE, PartialFeedPollError, partialCountsFromUnexpectedFeedError } from "@/lib/ingestion/discoveryPollingLifecycle";
import type { PromotedCandidate } from "@/lib/discovery/types";

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
 * Phase 6 PR 6.2: this route no longer creates ingestion_jobs directly.
 * Every valid feed item is now recorded as a discovery sighting through
 * the Phase 6 PR 6.1 candidate ledger (recordDiscoverySighting()), then
 * promoted in two bounded steps once all feeds in this invocation have
 * finished:
 *
 *   1. claimEligibleCandidatesForPromotionByIds() -- promotes exactly
 *      the candidate IDs observed by this invocation. Immune to
 *      competition from any unrelated historical backlog, since the
 *      query can only ever match rows from this invocation's own id set.
 *   2. claimEligibleCandidatesForPromotion(RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE)
 *      -- ONE bounded, unlooped call recovering eligible candidates left
 *      behind by an earlier invocation whose own promotion step failed
 *      partway. See discoveryPollingLifecycle.ts for why 250 is the
 *      locked recovery quota.
 *
 * Every syntactically valid URL observed through an enabled,
 * admin-configured RSS/Atom feed is recorded with admissibility:
 * "eligible" (LOCKED PM decision) -- this means pipeline admission only.
 * It conveys ZERO epistemic trust, confidence, corroboration,
 * independence, provenance weight, or truth status. Multiple RSS/feed
 * observations of the same URL remain operational discovery facts only
 * (discovery_candidate_observations rows) and never influence claims,
 * evidence, source_relationships, claim confidence, public status, or
 * any provenance conclusion -- that graph remains exclusively
 * analyse_provenance's and a human reviewer's. All existing downstream
 * AI/human review safeguards are entirely unaffected by this bridge.
 *
 * This route performs discovery-ledger recording (discovery_candidates
 * / discovery_candidate_observations, via recordDiscoverySighting()) and
 * ingestion-job queueing only -- it does NOT fetch or process an article
 * page, does NOT run duplicate detection against source_items, and does
 * NOT run any downstream claim/AI/provenance processing, all of which
 * remain PR 9's processor's own responsibility. That separation of
 * concerns is deliberate, not an oversight: "discovery" (this route) and
 * "processing" (PR 9's route) are independently replaceable stages.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface FeedOutcomeSummary {
  feedId: number;
  feedUrl: string;
  status: string;
  itemsParsed: number;
  sightingsRecorded: number;
  malformedUrlsSkipped: number;
}

/** Turns a safeFetch failure into the short status string recorded on discovery_feeds.last_poll_status -- reuses safeFetch's own error-code vocabulary rather than inventing a new one. */
function fetchFailureStatus(code: string): string {
  return `error: ${code}`;
}

/**
 * Polls one feed and records every valid item as a discovery sighting.
 * Deliberately does NOT promote anything itself -- promotion happens
 * once, after ALL feeds in this invocation have been polled (see
 * runPoller()), so that claimEligibleCandidatesForPromotionByIds() can
 * be given the complete set of candidate ids this whole invocation
 * observed, not just this one feed's.
 *
 * `observedCandidateIds` is a single Set shared across every feed polled
 * in this invocation -- accumulating into one Set here is what lets the
 * caller de-duplicate cheaply (same URL surfacing via two different
 * feeds collapses to one candidate id) without any extra query.
 */
async function pollOneFeed(
  feed: ClaimedDiscoveryFeed,
  rssProviderId: number,
  observedCandidateIds: Set<number>
): Promise<FeedOutcomeSummary> {
  const fetchResult = await safeFetch(feed.feedUrl);

  if (!fetchResult.ok) {
    const status = fetchFailureStatus(fetchResult.error.code);
    await recordFeedPollOutcome(feed.id, status);
    return { feedId: feed.id, feedUrl: feed.feedUrl, status, itemsParsed: 0, sightingsRecorded: 0, malformedUrlsSkipped: 0 };
  }

  const parsed = parseFeed(fetchResult.bodyText);
  if (!parsed.ok) {
    const status = `error: ${parsed.error.code}`;
    await recordFeedPollOutcome(feed.id, status);
    return { feedId: feed.id, feedUrl: feed.feedUrl, status, itemsParsed: 0, sightingsRecorded: 0, malformedUrlsSkipped: 0 };
  }

  let sightingsRecorded = 0;
  let malformedUrlsSkipped = 0;

  try {
    // Sequential, not parallel -- matches PR 9's own reasoning: keeps this
    // feed's total time easy to reason about, and avoids many concurrent
    // writes racing each other pointlessly within the SAME invocation.
    for (const item of parsed.items) {
      // recordDiscoverySighting() is the single authoritative
      // normalization/rejection boundary (Phase 6 PR 6.2) -- it calls the
      // canonical normalizeUrl() internally and returns "invalid_url"
      // BEFORE touching either ledger table, so a second normalizeUrl()
      // call at this route level would be redundant, not defense-in-depth
      // (same pure function, same input, run twice).
      const result = await recordDiscoverySighting({
        rawUrl: item.rawUrl,
        discoveryProviderId: rssProviderId,
        discoveryFeedId: feed.id,
        admissibility: "eligible",
      });

      if (result.outcome === "invalid_url") {
        malformedUrlsSkipped += 1;
        continue;
      }

      sightingsRecorded += 1;
      observedCandidateIds.add(result.candidateId);
    }

    // "sightingsRecorded" is a valid sighting that successfully passed
    // through recordDiscoverySighting() -- it may be a same-feed replay
    // (advancing last_seen_at only) or a genuinely new observation; the
    // ledger's own design deliberately does not expose that distinction to
    // this caller (Phase 6 PR 6.1), so this route never claims to know it
    // either. Never described as "new"/"created" for exactly that reason.
    //
    // This write is deliberately INSIDE the same try block as the item
    // loop above, not after it: an unexpected throw from this call would
    // otherwise escape with no way to attach the counts already
    // accumulated (all real item-processing work is done by this point),
    // and runPoller's outer catch would fall back to reporting zero
    // progress on a feed that actually succeeded end to end. See
    // PartialFeedPollError's own header.
    const status = `ok: ${parsed.items.length} items parsed, ${sightingsRecorded} sightings recorded, ${malformedUrlsSkipped} malformed skipped`;
    await recordFeedPollOutcome(feed.id, status);

    return {
      feedId: feed.id,
      feedUrl: feed.feedUrl,
      status,
      itemsParsed: parsed.items.length,
      sightingsRecorded,
      malformedUrlsSkipped,
    };
  } catch (err) {
    // An unexpected exception -- whether partway through this feed's
    // items, or from the final success-path recordFeedPollOutcome()
    // write above -- must not silently discard the progress already
    // made -- every sighting recorded so far is already committed
    // (recordDiscoverySighting() is its own transaction per call) and
    // its candidate id is already in observedCandidateIds. This error
    // exists only to carry the REPORTING counts up to runPoller's outer
    // catch, which would otherwise have no way to distinguish "this feed
    // made real progress before failing" from "this feed failed
    // immediately" and would falsely report zero for both.
    throw new PartialFeedPollError(parsed.items.length, sightingsRecorded, malformedUrlsSkipped, err);
  }
}

async function runPoller(): Promise<{
  startedAt: string;
  durationMs: number;
  claimedCount: number;
  outcomes: FeedOutcomeSummary[];
  uniqueCandidateIdsObserved: number;
  currentPollPromoted: number;
  globalRecoveryPromoted: number;
  totalJobsPromoted: number;
}> {
  const startedAt = new Date();

  const rssProviderId = await getRssDiscoveryProviderId();
  const claimed = await claimDueDiscoveryFeeds(startedAt);
  const observedCandidateIds = new Set<number>();

  const outcomes: FeedOutcomeSummary[] = [];
  for (const feed of claimed) {
    try {
      outcomes.push(await pollOneFeed(feed, rssProviderId, observedCandidateIds));
    } catch (err) {
      // Same reasoning as PR 9's route: pollOneFeed is expected to
      // handle every ordinary failure itself via the typed
      // safeFetch/parseFeed/recordDiscoverySighting result shapes.
      // Reaching here means something genuinely unexpected happened.
      // The feed must not be left showing 'polling' indefinitely, so its
      // status is explicitly finalized right now. The real error is
      // logged server-side only.
      //
      // Phase 6 PR 6.2 correction: partialCountsFromUnexpectedFeedError()
      // recovers whatever progress pollOneFeed had already made before
      // throwing (see PartialFeedPollError's own header) -- reporting
      // hardcoded zeros here would falsely claim no progress occurred
      // even when several items were already successfully recorded (and
      // their candidate ids are already sitting in observedCandidateIds,
      // to be promoted below regardless of this feed's own error status).
      console.error(`[discovery-poller] feed ${feed.id} threw unexpectedly:`, err);
      const partial = partialCountsFromUnexpectedFeedError(err);
      const status = `error: unexpected_error (partial progress: ${partial.itemsParsed} items parsed, ${partial.sightingsRecorded} sightings recorded, ${partial.malformedUrlsSkipped} malformed skipped)`;
      await recordFeedPollOutcome(feed.id, status);
      outcomes.push({
        feedId: feed.id,
        feedUrl: feed.feedUrl,
        status,
        itemsParsed: partial.itemsParsed,
        sightingsRecorded: partial.sightingsRecorded,
        malformedUrlsSkipped: partial.malformedUrlsSkipped,
      });
    }
  }

  // Promotion happens once, after every feed in this invocation has
  // finished, in two bounded steps (Phase 6 PR 6.2 -- see this file's
  // header). Neither step loops.
  const currentPollPromoted: PromotedCandidate[] = await claimEligibleCandidatesForPromotionByIds(
    Array.from(observedCandidateIds)
  );

  // A single bounded call, never looped -- see
  // discoveryPollingLifecycle.ts for why RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE
  // is 250 and why one call per successful invocation is sufficient.
  // Naming this "globalRecoveryPromoted" rather than "backlog promoted":
  // this second call is genuinely global (no id restriction), so it is
  // *possible* -- though not the common case -- for it to promote a
  // candidate from THIS poll that SKIP LOCKED had briefly made
  // unavailable to the id-scoped call above and that became claimable by
  // the time this second call ran. Not every row promoted here is
  // necessarily old historical backlog.
  const globalRecoveryPromoted: PromotedCandidate[] = await claimEligibleCandidatesForPromotion(
    RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE
  );

  const durationMs = Date.now() - startedAt.getTime();

  return {
    startedAt: startedAt.toISOString(),
    durationMs,
    claimedCount: claimed.length,
    outcomes,
    uniqueCandidateIdsObserved: observedCandidateIds.size,
    currentPollPromoted: currentPollPromoted.length,
    globalRecoveryPromoted: globalRecoveryPromoted.length,
    totalJobsPromoted: currentPollPromoted.length + globalRecoveryPromoted.length,
  };
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
