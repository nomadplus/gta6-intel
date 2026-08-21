import "server-only";
import { eq } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs, aiResults } from "@/db/schema";
import { isUniqueViolation } from "./shared";
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

export type CreatePendingAiJobResult =
  | { ok: true; id: number }
  | {
      /**
       * Phase 5 PR 3: the INSERT itself was rejected by
       * ai_jobs_classify_relevance_inflight_unique (migration 0014) --
       * another in-flight (pending/running) classify_relevance job
       * already exists for this exact source item. No row was created
       * for THIS attempt; the existing in-flight row already fully
       * represents the ongoing work, so there is nothing further to
       * persist here.
       */
      ok: false;
      reason: "already_in_flight";
    };

/**
 * Inserts a new `ai_jobs` row in the 'pending' state. Returns its id for
 * the caller to drive through the rest of the lifecycle -- or, when
 * `sourceItemId` is supplied for a classify_relevance operation and
 * collides with an already in-flight job for that same source item, a
 * typed `already_in_flight` result instead of a thrown error. This is an
 * ordinary, expected outcome (two callers racing to classify the same
 * source item), not a misconfiguration -- callers must not treat it as a
 * crash.
 */
export async function createPendingAiJob(input: PendingAiJobInput): Promise<CreatePendingAiJobResult> {
  try {
    const [row] = await adminDb
      .insert(aiJobs)
      .values(buildPendingAiJobValues(input))
      .returning({ id: aiJobs.id });
    return { ok: true, id: row!.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_in_flight" };
    }
    throw err;
  }
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
  /** Phase 5 PR 2: an already exact-formatted numeric(10,6) string -- see aiJobLifecycle.ts's buildSuccessPatch header for why this is a string, not a raw number. */
  costEstimateUsd?: string | null;
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
  /** Phase 5 PR 2: an already exact-formatted numeric(10,6) string. Populated when a failure still consumed billable tokens (e.g. invalid_structured_output reached the provider); left null for a failure that never reached the provider (e.g. a safety-blocked execution -- see evaluateAiSafety.ts). */
  costEstimateUsd?: string | null;
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
        costEstimateUsd: input.costEstimateUsd,
      })
    )
    .where(eq(aiJobs.id, input.jobId));
}
