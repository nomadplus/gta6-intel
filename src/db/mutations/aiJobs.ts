import "server-only";
import { eq } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs, aiResults } from "@/db/schema";
import {
  buildPendingAiJobValues,
  buildRunningPatch,
  buildSuccessPatch,
  buildFailurePatch,
  type PendingAiJobInput,
} from "@/lib/ai/aiJobLifecycle";

/**
 * Phase 5 PR 1: the I/O layer for the generic ai_jobs / ai_results
 * lifecycle -- deliberately operation-agnostic, mirroring the pure/I-O
 * split already established by src/lib/ingestion/ingestionJobLifecycle.ts
 * (patches) vs src/db/mutations/ingestion.ts (writes). This file knows
 * nothing about classifyRelevance, extractClaims, or any other real
 * operation's business logic -- that is exactly the boundary the
 * approved PR1 plan draws.
 *
 * No requireAdmin()/audit-log call here: unlike the admin CRUD mutations,
 * these writes are not a live admin request -- they're an automated AI
 * operation's own bookkeeping, same category as ingestionProcessor.ts's
 * job claiming, which also has no admin session to check.
 */

export interface CreatedAiJob {
  id: number;
}

/** Inserts a new `ai_jobs` row in the 'pending' state. Returns its id for the caller to drive through the rest of the lifecycle. */
export async function createPendingAiJob(input: PendingAiJobInput): Promise<CreatedAiJob> {
  const [row] = await adminDb
    .insert(aiJobs)
    .values(buildPendingAiJobValues(input))
    .returning({ id: aiJobs.id });
  return row;
}

/** Transitions a job to 'running' immediately before the provider call begins. */
export async function markAiJobRunning(jobId: number, now: Date = new Date()): Promise<void> {
  await adminDb.update(aiJobs).set(buildRunningPatch(now)).where(eq(aiJobs.id, jobId));
}

export interface CompleteAiJobSuccessInput {
  jobId: number;
  now?: Date;
  tokensIn: number;
  tokensOut: number;
  costEstimateUsd?: number | null;
  /** The already Zod-validated structured output -- never an unvalidated raw provider payload. */
  structuredOutput: unknown;
  /** Optional -- most operations won't populate these in PR1 since no real operation exists yet; see runAiOperation.ts's duck-typed extraction. */
  confidence?: number | null;
  reasoning?: string | null;
  claimId?: number | null;
}

export interface CompletedAiJobSuccess {
  jobId: number;
  aiResultId: number;
}

/**
 * Atomically (single transaction) marks the job 'succeeded' AND inserts
 * the corresponding ai_results row -- the two are never split across
 * separate calls, so a crash between them can never leave a 'succeeded'
 * job with no result, or a result row with no completed job.
 */
export async function completeAiJobSuccess(input: CompleteAiJobSuccessInput): Promise<CompletedAiJobSuccess> {
  const now = input.now ?? new Date();
  return adminDb.transaction(async (tx) => {
    await tx
      .update(aiJobs)
      .set(
        buildSuccessPatch({
          now,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          costEstimateUsd: input.costEstimateUsd,
        })
      )
      .where(eq(aiJobs.id, input.jobId));

    const [result] = await tx
      .insert(aiResults)
      .values({
        aiJobId: input.jobId,
        claimId: input.claimId ?? null,
        structuredOutput: input.structuredOutput,
        confidence: input.confidence != null ? input.confidence.toFixed(3) : null,
        reasoning: input.reasoning ?? null,
      })
      .returning({ id: aiResults.id });

    return { jobId: input.jobId, aiResultId: result.id };
  });
}

export interface CompleteAiJobFailureInput {
  jobId: number;
  now?: Date;
  error: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** Marks the job 'failed'. Deliberately writes NO ai_results row -- there is nothing valid to store, and ai_results.structured_output is NOT NULL, so a failed job correctly produces zero result rows. */
export async function completeAiJobFailure(input: CompleteAiJobFailureInput): Promise<void> {
  const now = input.now ?? new Date();
  await adminDb
    .update(aiJobs)
    .set(
      buildFailurePatch({
        now,
        error: input.error,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
      })
    )
    .where(eq(aiJobs.id, input.jobId));
}
