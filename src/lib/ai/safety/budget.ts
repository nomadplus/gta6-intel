import "server-only";
import { and, gte, lt } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { aiJobs } from "@/db/schema";
import { parseUsdStringToMicros } from "./money";

/**
 * Phase 5 PR 2: a MANDATORY, SOFT, PREFLIGHT monthly spend threshold --
 * "mandatory" because PR 2 exists specifically to establish the
 * spend-safety boundary before automated AI execution is introduced, and
 * an operator forgetting to set AI_MONTHLY_BUDGET_USD must never
 * silently mean "unlimited spend." "Soft, preflight" because, once
 * configured, this is explicitly NOT a hard, concurrency-safe spending
 * ceiling, and this file must never be described as guaranteeing one. It
 * answers exactly one question: "as of the last recorded ai_jobs row,
 * has cumulative spend already reached or crossed AI_MONTHLY_BUDGET_USD"
 * -- checked once per runAiOperation() call, using only PAST,
 * already-persisted cost_estimate_usd values.
 *
 * Two DISTINCT, independently real overrun mechanisms follow from that:
 *
 * 1. SINGLE-CALL OVERRUN (exists even with a single caller, zero
 *    concurrency): this check cannot know the cost of the call it is
 *    about to admit -- that cost only becomes known AFTER the provider
 *    responds with real token counts. A call is admitted whenever prior
 *    spend is strictly below the ceiling, regardless of how large that
 *    one call's own eventual cost turns out to be. Total spend after the
 *    call completes can therefore exceed the ceiling by up to the cost of
 *    that single call. This is not a bug to be fixed by "checking more
 *    carefully" -- it is inherent to a preflight-only design that has no
 *    estimate of the upcoming call's cost before invoking the provider.
 *
 * 2. CONCURRENCY OVERRUN (additive on top of #1): two or more calls
 *    racing this check at the same instant can each independently
 *    observe "not yet over the ceiling" and each be admitted before any
 *    of their own cost is recorded -- multiplying the possible overrun by
 *    the number of calls in flight at once.
 *
 * A hard, concurrency-safe reservation system (e.g. an atomic pre-charge
 * against a ledger, refunded/adjusted after the real cost is known) would
 * close both gaps, but is deliberately NOT built in this PR: Phase 5 PR 2
 * explicitly excludes ingestion-triggered/batched AI execution, so today
 * there is no code path that issues concurrent AI calls at all -- the
 * realistic worst case is "one or two manually-triggered calls in flight
 * at once," making a reservation ledger disproportionate complexity for
 * the risk it would close right now. Build that hard ceiling when a
 * future PR actually introduces concurrent or batched AI invocation --
 * do not assume this file already covers that case before then.
 */

export class MissingAiBudgetConfigError extends Error {
  constructor() {
    super(
      'AI_MONTHLY_BUDGET_USD is not set -- Phase 5 PR 2 requires an explicit monthly spend threshold before any AI provider call can be attempted; there is no "unlimited spend" default. Set it to a non-negative decimal USD amount (e.g. "50", or "0" to block all AI execution until raised).'
    );
    this.name = "MissingAiBudgetConfigError";
  }
}

export class MalformedAiBudgetConfigError extends Error {
  constructor(rawValue: string, cause: unknown) {
    super(
      `AI_MONTHLY_BUDGET_USD is set to "${rawValue}", which is not a valid non-negative decimal USD amount -- refusing to guess. Fix the value to a non-negative decimal amount (e.g. "50" or "0").`
    );
    this.name = "MalformedAiBudgetConfigError";
    this.cause = cause;
  }
}

/**
 * Reads AI_MONTHLY_BUDGET_USD. MANDATORY: unset throws
 * MissingAiBudgetConfigError -- there is deliberately no "not configured
 * yet, so allow unlimited spend" fallback, since forgetting to set this
 * variable must fail closed, not silently disable the primary cost
 * safeguard PR 2 exists to establish. Empty string, or any value that
 * isn't a plain non-negative decimal (including a negative number, which
 * the parser's digits-only pattern already rejects), throws
 * MalformedAiBudgetConfigError. "0" is a valid, accepted value -- it
 * parses to a ceiling of exactly 0 micro-USD, which (compared against a
 * month-to-date spend that is always >= 0) blocks every single AI call
 * once evaluated, with no special-cased "zero means off" branch needed
 * anywhere in this file or in evaluateAiSafety.ts.
 */
export function getMonthlyBudgetCeilingMicros(): bigint {
  const raw = process.env.AI_MONTHLY_BUDGET_USD;
  if (raw === undefined) {
    throw new MissingAiBudgetConfigError();
  }
  try {
    return parseUsdStringToMicros(raw);
  } catch (err) {
    throw new MalformedAiBudgetConfigError(raw, err);
  }
}

/** [start, end) of the UTC calendar month containing `now`. UTC (not local/server time) to match every other timestamp convention already in this project (timestamptz columns, the 06:00 UTC ingestion cron). */
export function utcMonthBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

export interface MonthToDateSpend {
  spentMicros: bigint;
  /** True if one or more rows in the window have a NULL cost_estimate_usd -- their contribution is treated as $0, which understates real spend. Surfaced so callers can log it (Section 19 observability), not to block on it. */
  hasUnmeasuredRows: boolean;
}

/**
 * Sums ai_jobs.cost_estimate_usd for the UTC calendar month containing
 * `now`, across ALL job statuses -- not just 'succeeded'. A call that
 * failed AFTER reaching the provider (e.g. invalid_structured_output)
 * still consumed billable tokens; excluding failed jobs would
 * systematically undercount real spend. Rows blocked BEFORE the provider
 * was ever called (kill switch / budget / unpriced-model) are correctly
 * NULL-cost and contribute nothing, since nothing was spent.
 *
 * Deliberately sums in JS (as BigInt) over plain SELECTed rows rather
 * than a database-side SUM() -- keeps every arithmetic step in the same
 * exact BigInt domain as money.ts/pricing.ts, with no reliance on how a
 * given driver/ORM version coerces Postgres NUMERIC into a JS SUM
 * result. This project's current volume makes that a non-issue; revisit
 * if ai_jobs ever grows large enough to matter.
 */
export async function getMonthToDateSpendMicros(now: Date): Promise<MonthToDateSpend> {
  const { start, end } = utcMonthBounds(now);
  const rows = await adminDb
    .select({ costEstimateUsd: aiJobs.costEstimateUsd })
    .from(aiJobs)
    .where(and(gte(aiJobs.createdAt, start), lt(aiJobs.createdAt, end)));

  let spentMicros = 0n;
  let hasUnmeasuredRows = false;
  for (const row of rows) {
    if (row.costEstimateUsd === null) {
      hasUnmeasuredRows = true;
      continue;
    }
    spentMicros += parseUsdStringToMicros(row.costEstimateUsd);
  }
  return { spentMicros, hasUnmeasuredRows };
}
