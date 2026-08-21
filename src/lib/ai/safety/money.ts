/**
 * Phase 5 PR 2: exact-money arithmetic using BigInt exclusively -- no
 * `number` is ever used for a value that participates in a cost/budget
 * calculation, and no `parseFloat`, floating-point multiplication or
 * division, or `.toFixed()` money formatting exists anywhere in this
 * file or its callers (pricing.ts, budget.ts, evaluateAiSafety.ts,
 * runAiOperation.ts). Everything is expressed in integer MICRO-USD
 * (1 micro-USD = 0.000001 USD) -- the same scale as
 * ai_jobs.cost_estimate_usd's `numeric(10,6)` column, so a micro-USD
 * BigInt maps onto that column with a single, explicit formatting step
 * and no ambiguity about rounding direction.
 *
 * Why BigInt specifically, not just integer `number` math: `number`
 * multiplication/addition of safe integers IS exact in JS (IEEE-754
 * doubles represent every integer exactly up to 2^53-1), so the previous
 * version of this file (integer micro-USD-per-token, as plain numbers)
 * was not actually producing wrong answers for the models it happened to
 * list. But that safety depended on every listed price being a whole
 * number of micro-USD-per-token, which is only true because every
 * currently-listed model happens to have a whole-dollar-per-million-token
 * rate. Anthropic's own published rate card includes fractional-dollar
 * rates (e.g. legacy Haiku 3.5 cache reads at $0.08/MTok), and this
 * project's pricing map WILL eventually need to represent a rate like
 * that. BigInt removes the need to reason, model by model, about whether
 * a given price happens to divide evenly -- it is exact by construction
 * regardless of what rate gets added next.
 */

/** Converts an integer micro-USD BigInt amount into the fixed 6-decimal string ai_jobs.cost_estimate_usd (numeric(10,6)) expects. */
export function microsToUsdString(micros: bigint): string {
  if (micros < 0n) {
    throw new Error(`microsToUsdString expects a non-negative integer micro-USD amount, got: ${micros}`);
  }
  const whole = micros / 1_000_000n;
  const fraction = micros % 1_000_000n;
  return `${whole}.${fraction.toString().padStart(6, "0")}`;
}

/**
 * Parses an operator-supplied decimal USD string (e.g. "50", "50.00",
 * "12.5") -- as would be set in AI_MONTHLY_BUDGET_USD, or as read back
 * from ai_jobs.cost_estimate_usd -- into integer micro-USD as a BigInt.
 * Throws on anything that isn't a plain non-negative decimal number,
 * rather than falling back to a permissive parse -- an unparseable
 * budget ceiling must fail closed (see budget.ts), never silently become
 * "no limit." Parsing is done entirely on the regex-captured digit
 * strings via `BigInt(string)`, never `Number()`/`parseFloat()`, so there
 * is no floating-point step anywhere in this path, regardless of how
 * many digits the caller supplies.
 */
export function parseUsdStringToMicros(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`"${value}" is not a valid non-negative decimal USD amount (expected e.g. "50" or "12.50").`);
  }
  const [, wholePart, fractionPart = ""] = match;
  const paddedFraction = fractionPart.padEnd(6, "0");
  return BigInt(wholePart) * 1_000_000n + BigInt(paddedFraction);
}
