/**
 * Regression check for src/lib/ingestion/statusMapping.ts.
 *
 * Run with: npx tsx src/checks/ingestionStatusMapping.check.ts
 */
import {
  mapSafeFetchFailureToIngestionOutcome,
  classifySuccessfulFetchForPaywall,
} from "../lib/ingestion/statusMapping";
import type { SafeFetchError, SafeFetchErrorCode } from "../lib/ingestion/safeFetch";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function err(code: SafeFetchErrorCode, extra: Partial<SafeFetchError> = {}): SafeFetchError {
  return { code, message: `safe generic message for ${code}`, ...extra };
}

// --- Auth / rate limit ----------------------------------------------------
assert(
  mapSafeFetchFailureToIngestionOutcome(err("auth_required")).status === "authentication_required",
  "401 (auth_required) -> authentication_required"
);
{
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("rate_limited"));
  assert(outcome.status === "rate_limited", "429 (rate_limited) -> rate_limited");
  assert(outcome.resultKind === "failed", "rate_limited is a 'failed' result kind, not needs_review");
}

// --- Ambiguous 403 -> needs_review, never auto-paywalled -------------------
{
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("forbidden", { status: 403 }));
  assert(outcome.status === "needs_review", "ambiguous 403 does NOT automatically become paywalled -- routes to needs_review instead");
  assert(outcome.resultKind === "needs_review", "403 outcome's resultKind is needs_review");
}

// --- 402 -> paywalled, high-confidence, same tier as 401 -------------------
{
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("http_error", { status: 402 }));
  assert(outcome.status === "paywalled", "HTTP 402 -> paywalled");
  assert(outcome.resultKind === "failed", "402 paywalled outcome is a definitive 'failed' result, not needs_review");
}

// --- Generic http_error (404 etc) ------------------------------------------
{
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("http_error", { status: 404 }));
  assert(outcome.status === "fetch_failed", "404 (generic http_error) -> fetch_failed");
}

// --- Timeout / network / 5xx -----------------------------------------------
for (const code of ["timeout", "network_error", "server_error"] as const) {
  const outcome = mapSafeFetchFailureToIngestionOutcome(err(code));
  assert(outcome.status === "fetch_failed", `${code} -> fetch_failed`);
}

// --- SSRF / policy blocks ---------------------------------------------------
for (const code of ["invalid_target", "dns_blocked"] as const) {
  const outcome = mapSafeFetchFailureToIngestionOutcome(err(code));
  assert(outcome.status === "blocked_by_policy", `${code} -> blocked_by_policy`);
}

// --- DNS resolution failure is NOT a policy block (could be transient) -----
{
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("dns_resolution_failed"));
  assert(outcome.status === "fetch_failed", "dns_resolution_failed -> fetch_failed (not blocked_by_policy)");
}

// --- Content-type / size ---------------------------------------------------
assert(
  mapSafeFetchFailureToIngestionOutcome(err("unsupported_content_type")).status === "unsupported",
  "unsupported_content_type -> unsupported"
);
assert(
  mapSafeFetchFailureToIngestionOutcome(err("response_too_large")).status === "unsupported",
  "response_too_large -> unsupported"
);

// --- Malformed redirects -----------------------------------------------
assert(
  mapSafeFetchFailureToIngestionOutcome(err("redirect_invalid")).status === "malformed",
  "redirect_invalid -> malformed"
);
assert(
  mapSafeFetchFailureToIngestionOutcome(err("redirect_loop")).status === "malformed",
  "redirect_loop -> malformed"
);
assert(
  mapSafeFetchFailureToIngestionOutcome(err("too_many_redirects")).status === "fetch_failed",
  "too_many_redirects -> fetch_failed (retryable, not malformed)"
);

// --- failureReason never leaks raw driver text -----------------------------
{
  const safeMessage = "This is a safe, generic message.";
  const outcome = mapSafeFetchFailureToIngestionOutcome(err("network_error", { message: safeMessage }));
  assert(outcome.failureReason === safeMessage, "failureReason is exactly the safe message from SafeFetchError, nothing appended/leaked");
}

// --- Successful-fetch paywall classification --------------------------------
assert(classifySuccessfulFetchForPaywall(false) === "paywalled", "isAccessibleForFree: false -> paywalled");
assert(classifySuccessfulFetchForPaywall(true) === null, "isAccessibleForFree: true -> no paywall classification");
assert(classifySuccessfulFetchForPaywall(null) === null, "isAccessibleForFree: null (no signal) -> no paywall classification, never guessed");

if (failures > 0) {
  console.error(`\n${failures} status mapping check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll status mapping checks passed.");
}
