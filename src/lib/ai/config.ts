import "server-only";

/**
 * Phase 5 PR 1: env-based AI configuration. Deliberately minimal and
 * read directly from process.env, matching the pattern already used by
 * requireCronSecret.ts and adminClient.ts elsewhere in this codebase --
 * there is no central "config service" convention in this project to
 * introduce one for.
 *
 * This module knows about model IDs and API keys, but nothing about
 * *what* those models are being asked to do -- that separation is what
 * lets future operation code (classifyRelevance, extractClaims, ...)
 * stay provider/model-agnostic (Section 9).
 */

export class MissingAiConfigError extends Error {
  constructor(variable: string, context: string) {
    super(`${variable} is not configured -- ${context}`);
    this.name = "MissingAiConfigError";
  }
}

/**
 * The model used when a caller doesn't supply an explicit override on
 * AiCompletionRequest.model. Read lazily (called at request time, not
 * at module import time) so that importing this module -- or any module
 * that transitively imports it -- never fails a build/typecheck/check
 * run simply because AI_DEFAULT_MODEL isn't set in that environment.
 * Only code paths that actually need a default model call this.
 */
export function getDefaultModel(): string {
  const model = process.env.AI_DEFAULT_MODEL;
  if (!model) {
    throw new MissingAiConfigError(
      "AI_DEFAULT_MODEL",
      "no model was specified for this AI request and there is no configured default."
    );
  }
  return model;
}

/**
 * The Anthropic API key. Also read lazily, from inside
 * AnthropicProvider's factory (getAnthropicProvider), never at module
 * import time -- constructing a provider is the point at which "we need
 * to actually call Anthropic" becomes true, not before.
 */
export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new MissingAiConfigError(
      "ANTHROPIC_API_KEY",
      "the Anthropic provider cannot be constructed without it."
    );
  }
  return key;
}
