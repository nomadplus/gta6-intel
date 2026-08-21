import "server-only";
import { getSourceItemForClassification } from "@/db/queries/admin";
import { classifyRelevance, type ClassifyRelevanceOutput } from "./classifyRelevance";
import { getAnthropicProvider } from "@/lib/ai/providers/anthropicProvider";
import type { AiProvider } from "@/lib/ai/types";
import type { RunAiOperationResult } from "@/lib/ai/runAiOperation";

/**
 * Phase 5 PR 3 architecture note: this is the ONE place that decides
 * which provider classify_relevance actually uses in production (the
 * real Anthropic provider) and loads the source-item fields the
 * operation needs. It deliberately does NOT live in
 * src/db/mutations/ingestion.ts or src/db/mutations/classificationRecovery.ts
 * -- those are database-persistence modules with no AI/provider
 * knowledge (Section 9/15: don't scatter AI orchestration into
 * unrelated application code, including the DB mutation layer itself).
 * This file is the shared orchestration boundary instead, called from
 * exactly two "use server" action sites:
 *   - src/app/admin/(protected)/ingest/actions.ts, strictly AFTER
 *     finalizeIngestionConfirmation()'s transaction has already
 *     committed -- confirmation is fully successful at that point
 *     regardless of what happens here next.
 *   - src/app/admin/(protected)/review/actions.ts, the admin recovery
 *     action for a missing/stale/failed classification.
 *
 * `provider` is injectable (defaults to the real Anthropic provider) so
 * checks can call this exact function with FakeAiProvider -- proving the
 * real orchestration path, not a reimplementation of it -- without
 * requiring ANTHROPIC_API_KEY. A default parameter value is only
 * evaluated when the argument is omitted, so passing an explicit fake
 * provider never touches getAnthropicProvider() at all.
 */
export class SourceItemNotFoundForClassificationError extends Error {
  constructor(sourceItemId: number) {
    super(`Source item #${sourceItemId} was not found -- cannot classify a source item that does not exist.`);
    this.name = "SourceItemNotFoundForClassificationError";
  }
}

export async function triggerClassifyRelevance(
  sourceItemId: number,
  provider: AiProvider = getAnthropicProvider()
): Promise<RunAiOperationResult<ClassifyRelevanceOutput>> {
  const sourceItem = await getSourceItemForClassification(sourceItemId);
  if (!sourceItem) throw new SourceItemNotFoundForClassificationError(sourceItemId);

  return classifyRelevance({ provider, sourceItem });
}
