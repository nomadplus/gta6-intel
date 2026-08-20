import "server-only";
import { NextResponse } from "next/server";
import { requireCronSecret, MissingCronSecretConfigError, UnauthorizedCronRequestError } from "@/lib/auth/requireCronSecret";
import {
  reclaimStaleFetchingJobs,
  claimEligibleIngestionJobsForProcessing,
  DEFAULT_PROCESSOR_BATCH_SIZE,
} from "@/db/mutations/ingestionProcessor";
import { completeJobFailure } from "@/db/mutations/ingestion";
import { processIngestionJob } from "@/lib/ingestion/pipeline";

/**
 * Phase 4 PR 9: automated ingestion job processor.
 *
 * Reclaims stale 'fetching' jobs and retries eligible failed jobs
 * without a live admin request -- see docs/architecture.md's PR 9
 * section for the full design rationale. This route does not create
 * new ingestion jobs from anything (no discovery_feeds reads, no
 * RSS/Atom parsing) -- it only ever acts on jobs that already exist in
 * ingestion_jobs. That remains PR 10's job.
 *
 * Trigger-agnostic by design (Section 15): this route doesn't know or
 * care whether it was invoked by Vercel's native cron (see vercel.json;
 * once/day on the current Hobby plan) or any other scheduler pointed at
 * the same URL with the right bearer token -- the only thing that
 * matters is the Authorization header. Both GET (what Vercel's cron
 * sends) and POST are accepted identically.
 *
 * maxDuration is set to the confirmed 300s Fluid Compute function
 * budget (see safeFetch.ts's header comment) -- a batch of
 * DEFAULT_PROCESSOR_BATCH_SIZE jobs, processed sequentially, is
 * comfortably inside that even in a worst case of every job needing the
 * full 45s safeFetch budget.
 */
export const maxDuration = 300;

// Route handlers have side effects (DB writes) and depend on runtime
// env vars -- never statically optimized/cached.
export const dynamic = "force-dynamic";

interface JobOutcomeSummary {
  jobId: number;
  attemptCount: number;
  kind: string;
  status?: string;
}

async function runProcessor(): Promise<{
  startedAt: string;
  durationMs: number;
  reclaimedStaleCount: number;
  claimedCount: number;
  outcomes: JobOutcomeSummary[];
}> {
  const startedAt = new Date();

  const reclaimed = await reclaimStaleFetchingJobs(startedAt);

  const claimed = await claimEligibleIngestionJobsForProcessing(startedAt, DEFAULT_PROCESSOR_BATCH_SIZE);

  // Sequential, not parallel: keeps this run's total time budget easy to
  // reason about against maxDuration, and avoids several claimed jobs
  // that happen to share a hostname all hitting it at the same instant.
  const outcomes: JobOutcomeSummary[] = [];
  for (const job of claimed) {
    try {
      const result = await processIngestionJob(job);
      outcomes.push({
        jobId: job.id,
        attemptCount: job.attemptCount,
        kind: result.kind,
        status: "status" in result ? result.status : undefined,
      });
    } catch (err) {
      // processIngestionJob is expected to catch and classify every
      // ordinary failure itself (that's the whole point of
      // statusMapping.ts) -- reaching here means something genuinely
      // unexpected happened (a bug, an unhandled rejection deep in a
      // dependency). The job must not be left stranded in 'fetching'
      // until the next run's stale-reclaim sweep, so it's explicitly
      // failed right now, through the same attempt-count-aware backoff
      // as any other failure. The real error is logged server-side only
      // -- never in the stored failureReason, which must stay a safe,
      // generic string (Section 13).
      console.error(`[ingestion-processor] job ${job.id} threw unexpectedly:`, err);
      await completeJobFailure(
        job.id,
        {
          status: "fetch_failed",
          failureReason: "An unexpected error occurred while processing this job.",
          resultKind: "failed",
        },
        job.attemptCount,
        null
      );
      outcomes.push({ jobId: job.id, attemptCount: job.attemptCount, kind: "failed", status: "fetch_failed" });
    }
  }

  const durationMs = Date.now() - startedAt.getTime();

  return {
    startedAt: startedAt.toISOString(),
    durationMs,
    reclaimedStaleCount: reclaimed.length,
    claimedCount: claimed.length,
    outcomes,
  };
}

async function handle(request: Request): Promise<Response> {
  try {
    requireCronSecret(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof MissingCronSecretConfigError) {
      // A misconfigured deployment, not a caller's fault -- still a
      // safe generic 500, never leaking which env var is missing.
      console.error("[ingestion-processor]", err.message);
      return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });
    }
    if (err instanceof UnauthorizedCronRequestError) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    throw err;
  }

  const summary = await runProcessor();

  // Structured, single-line, grep-able in Vercel's function logs --
  // this PR's entire observability story (Section 19), per the agreed
  // scope: no new table, no admin UI.
  console.log(`[ingestion-processor] ${JSON.stringify(summary)}`);

  return NextResponse.json(summary, { status: 200 });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
