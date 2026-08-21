/**
 * Regression check for Phase 5 PR 1 (src/lib/ai/aiJobLifecycle.ts):
 * pure patch-builder functions for the ai_jobs pending -> running ->
 * succeeded/failed lifecycle. No database, no network -- same shape as
 * src/checks/ingestionJobLifecycle.check.ts.
 *
 * Run with: npx tsx src/checks/aiJobLifecycle.check.ts
 */
import {
  buildPendingAiJobValues,
  buildRunningPatch,
  buildSuccessPatch,
  buildFailurePatch,
} from "../lib/ai/aiJobLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== ai_jobs lifecycle patch builders (Phase 5 PR 1 + PR 2) ===\n");

// --- buildPendingAiJobValues ------------------------------------------------

{
  const values = buildPendingAiJobValues({
    operation: "classify_relevance",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputRef: "source_item:42",
    sourceItemId: 42,
  });
  assert(values.status === "pending", "a freshly built job starts in 'pending'");
  assert(values.operation === "classify_relevance", "operation is carried through unchanged");
  assert(values.provider === "anthropic", "provider is carried through unchanged");
  assert(values.model === "claude-sonnet-5", "model is carried through unchanged");
  assert(values.inputRef === "source_item:42", "inputRef is carried through unchanged");
  assert(values.sourceItemId === 42, "sourceItemId (Phase 5 PR 3) is carried through unchanged");
}

{
  const values = buildPendingAiJobValues({ operation: "embed", provider: "fake", model: "test-model" });
  assert(values.inputRef === null, "omitted inputRef defaults to null, not undefined");
  assert(values.sourceItemId === null, "omitted sourceItemId (Phase 5 PR 3) defaults to null, not undefined");
}

// --- buildRunningPatch -------------------------------------------------------

{
  const now = new Date("2026-01-01T00:00:00Z");
  const patch = buildRunningPatch(now);
  assert(patch.status === "running", "running patch sets status to 'running'");
  assert(patch.startedAt === now, "running patch sets startedAt to the injected clock value, not a fresh Date()");
}

// --- buildSuccessPatch -------------------------------------------------------

{
  const now = new Date("2026-01-01T00:05:00Z");
  const patch = buildSuccessPatch({ now, tokensIn: 100, tokensOut: 40 });
  assert(patch.status === "succeeded", "success patch sets status to 'succeeded'");
  assert(patch.completedAt === now, "success patch sets completedAt to the injected clock value");
  assert(patch.tokensIn === 100 && patch.tokensOut === 40, "success patch carries token counts through unchanged");
  assert(patch.costEstimateUsd === null, "costEstimateUsd defaults to null when the caller supplies none");
  assert(patch.error === null, "success patch always clears error to null");
}

{
  // Phase 5 PR 2: buildSuccessPatch takes an already exact-formatted
  // numeric(10,6) string (produced by src/lib/ai/safety/money.ts's
  // microsToUsdString()), not a raw JS number -- this function performs
  // no float-to-string formatting itself, see its own header comment.
  const patch = buildSuccessPatch({ now: new Date(), tokensIn: 1, tokensOut: 1, costEstimateUsd: "0.006280" });
  assert(patch.costEstimateUsd === "0.006280", `an explicitly supplied costEstimateUsd string passes through unchanged (got ${patch.costEstimateUsd})`);
}

// --- buildFailurePatch --------------------------------------------------------

{
  const now = new Date("2026-01-01T00:10:00Z");
  const patch = buildFailurePatch({ now, error: "provider_error: timeout" });
  assert(patch.status === "failed", "failure patch sets status to 'failed'");
  assert(patch.completedAt === now, "failure patch sets completedAt to the injected clock value");
  assert(patch.error === "provider_error: timeout", "failure patch carries the error message through unchanged");
  assert(patch.tokensIn === null && patch.tokensOut === null, "omitted token counts default to null on failure (e.g. the provider call never returned usage at all)");
}

{
  const patch = buildFailurePatch({ now: new Date(), error: "invalid_structured_output: bad shape", tokensIn: 50, tokensOut: 0 });
  assert(patch.tokensIn === 50 && patch.tokensOut === 0, "token counts ARE persisted on a validation failure when the provider did return usage before failing validation");
  assert(patch.costEstimateUsd === null, "costEstimateUsd defaults to null on failure when the caller supplies none");
}

{
  // Phase 5 PR 2: a failure can still have consumed billable tokens
  // (e.g. invalid_structured_output reached the provider) -- cost must
  // be persistable on the failure path too, not just on success.
  const patch = buildFailurePatch({
    now: new Date(),
    error: "invalid_structured_output: bad shape",
    tokensIn: 50,
    tokensOut: 10,
    costEstimateUsd: "0.000200",
  });
  assert(patch.costEstimateUsd === "0.000200", `an explicitly supplied costEstimateUsd is persisted on a failure patch too (got ${patch.costEstimateUsd})`);
}

console.log(failures === 0 ? "\nAll ai_jobs lifecycle checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
