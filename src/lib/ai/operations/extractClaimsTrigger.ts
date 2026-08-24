import "server-only";
import { getSourceItemForClaimExtraction, getLatestSuccessfulClassifyRelevanceResult } from "@/db/queries/admin";
import { extractClaims, type ExtractClaimsOutput } from "./extractClaims";
import { getAnthropicProvider } from "@/lib/ai/providers/anthropicProvider";
import type { AiProvider } from "@/lib/ai/types";
import type { RunAiOperationResult } from "@/lib/ai/runAiOperation";

/**
 * Phase 5 PR 4 architecture note: this is the ONE place that decides
 * which provider extract_claims actually uses in production (the real
 * Anthropic provider), loads the source-item fields the operation needs,
 * AND enforces this operation's eligibility gate. Mirrors
 * classificationTrigger.ts's role exactly, plus the extra eligibility
 * check classify_relevance never needed (classify_relevance runs
 * unconditionally on every confirmed item; extract_claims must not).
 *
 * `provider` is injectable (defaults to the real Anthropic provider), so
 * checks can call this exact function with FakeAiProvider -- proving the
 * real orchestration path, not a reimplementation of it -- without
 * requiring ANTHROPIC_API_KEY.
 */

export class SourceItemNotFoundForExtractionError extends Error {
  constructor(sourceItemId: number) {
    super(`Source item #${sourceItemId} was not found -- cannot extract claims from a source item that does not exist.`);
    this.name = "SourceItemNotFoundForExtractionError";
  }
}

/**
 * Thrown when the source item's LATEST SUCCESSFUL classify_relevance
 * result is not exactly 'relevant' -- this includes never-classified,
 * only-ever-failed, currently-in-flight-with-no-prior-success, or a
 * latest successful result of 'irrelevant'/'needs_review'. See
 * getLatestSuccessfulClassifyRelevanceResult's own doc comment for the
 * exact semantics (a newer failed/pending/running classification does
 * NOT invalidate an earlier successful 'relevant' result; a newer
 * SUCCESSFUL 'irrelevant'/'needs_review' DOES supersede it).
 *
 * Checked BEFORE extractClaims() is called -- so before any ai_jobs row
 * is created and before any provider call is made. This is a hard
 * backend gate, not a UI convenience; the review page also hides/disables
 * the extraction action for ineligible items, but that is belt-and-braces,
 * not the actual enforcement.
 */
export class SourceItemNotEligibleForExtractionError extends Error {
  constructor(sourceItemId: number, latestSuccessfulRelevance: string | null) {
    super(
      `Source item #${sourceItemId} is not eligible for claim extraction -- ` +
        `its latest successful classify_relevance result is '${latestSuccessfulRelevance ?? "none"}', not 'relevant'.`
    );
    this.name = "SourceItemNotEligibleForExtractionError";
  }
}

export type TriggerExtractClaimsResult = RunAiOperationResult<ExtractClaimsOutput>;

export async function triggerExtractClaims(
  sourceItemId: number,
  provider: AiProvider = getAnthropicProvider()
): Promise<TriggerExtractClaimsResult> {
  const sourceItem = await getSourceItemForClaimExtraction(sourceItemId);
  if (!sourceItem) throw new SourceItemNotFoundForExtractionError(sourceItemId);

  const latestSuccessfulRelevance = await getLatestSuccessfulClassifyRelevanceResult(sourceItemId);
  if (latestSuccessfulRelevance !== "relevant") {
    throw new SourceItemNotEligibleForExtractionError(sourceItemId, latestSuccessfulRelevance);
  }

  return extractClaims({ provider, sourceItem });
}
