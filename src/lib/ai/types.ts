import type { z } from "zod";

/**
 * Phase 5 PR 1: the provider-neutral AI contract layer.
 *
 * This file defines ONLY the generic shapes every AI operation shares --
 * it does not know about classifyRelevance, extractClaims, or any other
 * real operation's prompts or business logic (those belong to their own
 * future PRs: 3/4/6/7). Keeping this file operation-agnostic is what lets
 * runAiOperation.ts, and every AiProvider implementation, stay identical
 * regardless of which operation is running or which provider is
 * configured -- per Section 9 (model-independent AI architecture) and
 * Section 10 (don't scatter provider-specific code) of the project's
 * standing architectural rules.
 */

/**
 * Mirrors the `ai_operation` Postgres enum (src/db/schema.ts). Kept as a
 * plain literal union here rather than importing the Drizzle enum object,
 * so this module has zero dependency on the database layer -- the
 * provider/orchestrator contracts should be usable (e.g. in the fake
 * provider, in checks) without ever touching drizzle-orm or pg.
 *
 * If this union and the database enum ever drift, aiJobs.ts's insert
 * will fail loudly (an invalid enum value is a Postgres error), so there
 * is no silent-mismatch risk in leaving these as two independently
 * maintained lists.
 */
export type AiOperation =
  | "classify_relevance"
  | "extract_claims"
  | "compare_claims"
  | "analyse_provenance"
  | "evaluate_evidence"
  | "recommend_status"
  | "embed"
  | "detect_duplicates";

/**
 * One request to an AiProvider. `outputSchema` is supplied by the CALLER
 * (i.e. by the future PR that actually implements classifyRelevance,
 * etc.) -- this file never hardcodes a schema for any specific
 * operation. The provider uses it to request structured output from the
 * underlying model; runAiOperation.ts additionally re-validates the
 * result against this same schema before trusting it (defense in depth
 * against a provider that claims to match a schema but doesn't).
 */
export interface AiCompletionRequest<T> {
  operation: AiOperation;
  /** Explicit per-call override. If omitted, the caller of runAiOperation should supply config.getDefaultModel(). Providers never choose a model on their own. */
  model: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: z.ZodType<T>;
  /**
   * Free-text pointer describing what was analyzed (e.g. "source_item:123"),
   * persisted verbatim to ai_jobs.input_ref. Not interpreted by the
   * provider or the orchestrator -- purely for observability.
   */
  inputRef?: string;
  /**
   * Phase 5 PR 4: optional per-request override of the provider's max
   * output tokens. Omitted -> the provider's own default is used
   * unchanged -- classify_relevance's existing behavior is untouched by
   * this addition. Exists so an operation whose worst-case structured
   * output is computable from its own schema (e.g. extractClaims, capped
   * at MAX_EXTRACTED_CLAIMS candidates) can bound its own spend/latency
   * tighter than the provider's flat default, without every other
   * operation having to adopt the same number.
   */
  maxOutputTokens?: number;
}

export interface AiTokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface AiCompletionSuccess<T> extends AiTokenUsage {
  ok: true;
  data: T;
}

export type AiCompletionFailureReason = "provider_error" | "invalid_structured_output";

export interface AiCompletionFailure extends Partial<AiTokenUsage> {
  ok: false;
  reason: AiCompletionFailureReason;
  message: string;
}

export type AiCompletionResult<T> = AiCompletionSuccess<T> | AiCompletionFailure;

/**
 * The one seam every real provider (Anthropic today; OpenAI/Google later,
 * if ever needed) and the fake test provider must implement identically.
 * `complete` must never throw for an ordinary provider or validation
 * failure -- it returns a typed AiCompletionFailure instead, so
 * runAiOperation.ts never needs a try/catch around "the model said
 * something we didn't expect."
 *
 * A provider MAY throw for truly exceptional conditions outside its
 * control (e.g. missing API key at construction time) -- that happens at
 * factory time (see config.ts), not inside complete().
 */
export interface AiProvider {
  /** Persisted verbatim into ai_jobs.provider (varchar(50)) -- keep short and stable, e.g. "anthropic", "fake". */
  readonly name: string;
  complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>>;
}
