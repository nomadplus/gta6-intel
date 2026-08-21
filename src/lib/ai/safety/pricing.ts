import "server-only";

/**
 * Phase 5 PR 2: static per-model pricing, expressed in integer
 * MICRO-USD-PER-MILLION-TOKENS (a BigInt) -- i.e. the model's published
 * dollars-per-million-tokens rate, multiplied by 1,000,000 and written as
 * a literal integer in source. This is a DIRECT, exact transcription of
 * Anthropic's rate card: e.g. $3.00/MTok becomes the literal `3_000_000n`
 * -- no runtime arithmetic ever produces these constants, so there is no
 * floating-point step even in constructing the table itself. Deliberately
 * NOT "micro-USD per single token" (an earlier version of this file used
 * that unit): that representation only stays exact for whole-dollar-per-
 * MTok rates, and silently breaks for a fractional-dollar rate (e.g. a
 * hypothetical $0.30/MTok cache-hit rate is not a whole number of
 * micro-USD per token). Per-million-tokens as an integer has no such
 * restriction -- it is exact for any rate Anthropic publishes to the
 * cent.
 *
 * Prices below are STANDARD (non-batch, non-cached, non-fast-mode,
 * global-inference-geo) rates, matching what AnthropicProvider actually
 * calls today (src/lib/ai/providers/anthropicProvider.ts uses a plain
 * messages.create with no batch/cache/fast-mode/inference_geo options) --
 * if a future PR adds any of those modifiers, this map (and
 * calculateCostMicros below) must be revisited together with that change,
 * since they change the effective per-token price.
 *
 * Deliberately a static in-code map, not a database table: there is no
 * demonstrated need yet for prices to be admin-editable at runtime
 * (Section 11 of the project's standing rules), and a model's price does
 * not change on a schedule this project needs to react to faster than a
 * deploy already happens for other reasons.
 *
 * SOURCE: every rate below was read directly from Anthropic's official
 * pricing documentation (platform.claude.com/docs/en/about-claude/
 * pricing) at the time this PR was authored -- standard (non-batch)
 * input/output rates only. Re-verify against that page before relying on
 * this in production, and whenever AI_DEFAULT_MODEL changes or a new
 * model is adopted; update ONLY this map.
 *
 * An unknown model is deliberately NOT treated as "no pricing data,
 * proceed anyway" -- see evaluateAiSafety.ts. Leaving a model unpriced
 * would make its spend permanently unmeasurable and invisible to the
 * budget ceiling, which is precisely the uncontrolled-spend scenario this
 * PR exists to prevent.
 */

export interface ModelPricing {
  inputMicrosPerMillionTokens: bigint;
  outputMicrosPerMillionTokens: bigint;
}

const PRICING: Record<string, ModelPricing> = {
  // Current-generation models only -- entries are added when this
  // project actually intends to use a model, not for completeness (an
  // unused entry is dead weight that can silently go stale). This
  // project's AI_DEFAULT_MODEL is expected to be one of these; if it is
  // ever changed to something not listed here, every AI call fails
  // closed (unknown_model_pricing) until this map is updated -- that is
  // the intended forcing function, not a bug to work around.
  "claude-haiku-4-5-20251001": { inputMicrosPerMillionTokens: 1_000_000n, outputMicrosPerMillionTokens: 5_000_000n },
  "claude-sonnet-4-6": { inputMicrosPerMillionTokens: 3_000_000n, outputMicrosPerMillionTokens: 15_000_000n },
  "claude-sonnet-5": { inputMicrosPerMillionTokens: 2_000_000n, outputMicrosPerMillionTokens: 10_000_000n },
  "claude-opus-4-8": { inputMicrosPerMillionTokens: 5_000_000n, outputMicrosPerMillionTokens: 25_000_000n },
  "claude-opus-5": { inputMicrosPerMillionTokens: 5_000_000n, outputMicrosPerMillionTokens: 25_000_000n },
};

/** Returns pricing for a model, or null if the model is not in the static map above -- callers must treat null as "cannot safely estimate cost," not as "cost is zero." */
export function getModelPricing(model: string): ModelPricing | null {
  return PRICING[model] ?? null;
}

/**
 * Exact cost, in integer micro-USD, for a completed (or attempted) call.
 * All BigInt arithmetic -- no `number` division, no `parseFloat`, no
 * `.toFixed()` anywhere in this calculation.
 *
 * ROUNDING POLICY (explicit, since one is mathematically unavoidable):
 * `tokens * microsPerMillionTokens` is an exact integer product with no
 * rounding needed, but dividing that product by 1,000,000 to get back
 * down to whole micro-USD units is NOT always exact -- e.g. 7 tokens at
 * a $0.30/MTok rate is a true cost of 2.1 micro-USD, which cannot be
 * represented at all in a 6-decimal-place USD column. This function uses
 * BigInt's native integer division, which TRUNCATES TOWARD ZERO (i.e.
 * rounds down, since costs are always non-negative) -- the sub-micro-USD
 * remainder is simply dropped. This is a deliberate, documented choice,
 * not an oversight: the maximum possible understatement is under one
 * micro-USD (< $0.000001) PER CALL, so even at a volume of one million
 * AI calls the cumulative understatement is bounded under $1 total --
 * negligible at any realistic budget size, and choosing "round down"
 * over "round up" or "round to nearest" was arbitrary among three
 * equally-negligible options; truncation was picked because it is what
 * BigInt division already does natively, with no extra rounding logic to
 * get right or test.
 */
export function calculateCostMicros(pricing: ModelPricing, tokensIn: number, tokensOut: number): bigint {
  const inputMicros = BigInt(tokensIn) * pricing.inputMicrosPerMillionTokens;
  const outputMicros = BigInt(tokensOut) * pricing.outputMicrosPerMillionTokens;
  return (inputMicros + outputMicros) / 1_000_000n;
}
