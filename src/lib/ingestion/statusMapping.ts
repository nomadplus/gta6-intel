/**
 * Maps safeFetch's typed failures, and post-fetch classification
 * signals, onto the existing `ingestion_status` enum. Deliberately no
 * new statuses are introduced -- the enum already anticipated every
 * case this module needs (see migration 0007's comment on why it's a
 * closed, fixed vocabulary).
 *
 * Every mapping decision below is documented at the point it's made,
 * not just listed -- this file IS the "document the mapping" deliverable
 * called for by the PR spec, not a supplement to it.
 */
import type { SafeFetchError } from "./safeFetch";

/**
 * The subset of `ingestion_status` this module ever assigns as the
 * result of a *failed or ambiguous* fetch. (`queued`, `fetching`,
 * `stored`, `duplicate` are lifecycle/success states assigned
 * elsewhere -- never by this mapping.)
 */
export type FailureIngestionStatus =
  | "blocked_by_policy"
  | "authentication_required"
  | "paywalled"
  | "unsupported"
  | "fetch_failed"
  | "rate_limited"
  | "malformed"
  | "needs_review";

export interface IngestionFailureOutcome {
  status: FailureIngestionStatus;
  /** Safe, human-readable text for `ingestion_jobs.failure_reason`. */
  failureReason: string;
  /**
   * Whether this outcome belongs in the pipeline's `failed` result kind
   * (nothing more to review -- a genuine failure) or `needs_review`
   * (fetch didn't cleanly succeed, but the situation is ambiguous enough
   * that an admin, not this pipeline, should decide what happens next).
   * `needs_review` here is deliberately rare -- see the 403 case below,
   * the only one that currently qualifies.
   */
  resultKind: "failed" | "needs_review";
}

/**
 * HTTP 402 is the one status-code-level high-confidence paywall signal
 * (Section 5) -- safeFetch itself doesn't special-case 402 (it falls
 * into its generic `http_error` bucket with `status: 402`), so that
 * check happens here, before the generic per-code table below.
 */
function classifyHttpError(error: SafeFetchError): IngestionFailureOutcome {
  if (error.status === 402) {
    // Same confidence tier and same resultKind as the JSON-LD
    // isAccessibleForFree:false signal (classifySuccessfulFetchForPaywall
    // below) and as auth_required (401): a definitive, terminal
    // classification -- "failed" here means "did not reach
    // ready_for_confirmation", not "something went wrong". Section 12
    // still applies regardless of resultKind: nothing is auto-created
    // from ANY outcome in this PR, confirmation is always a separate
    // explicit admin step.
    return {
      status: "paywalled",
      failureReason: "The server responded with 402 Payment Required.",
      resultKind: "failed",
    };
  }
  return {
    status: "fetch_failed",
    failureReason: error.message,
    resultKind: "failed",
  };
}

/**
 * safeFetch error code -> ingestion outcome. One entry per
 * `SafeFetchErrorCode`; see each case's inline rationale for why that
 * status (not a different one) was chosen.
 */
export function mapSafeFetchFailureToIngestionOutcome(error: SafeFetchError): IngestionFailureOutcome {
  switch (error.code) {
    // Our own pre-flight validation rejected the target (bad scheme,
    // embedded credentials, malformed URL, or a literal blocked
    // hostname/IP) -- a deliberate policy decision on our side, not
    // anything about the target actually failing to respond.
    case "invalid_target":
      return { status: "blocked_by_policy", failureReason: error.message, resultKind: "failed" };

    // DNS resolved the hostname to a private/blocked address -- same
    // policy reasoning as invalid_target, just discovered one step
    // later (after resolution instead of at parse time).
    case "dns_blocked":
      return { status: "blocked_by_policy", failureReason: error.message, resultKind: "failed" };

    // The hostname didn't resolve at all. Unlike dns_blocked this is
    // not a policy decision -- it may be transient (registrar/DNS
    // outage) or a genuinely dead domain; fetch_failed is the
    // "retryable network-shaped failure" bucket for exactly this kind
    // of ambiguity.
    case "dns_resolution_failed":
      return { status: "fetch_failed", failureReason: error.message, resultKind: "failed" };

    // The target's own redirect response was non-conformant (missing
    // or unparseable Location header) -- a property of that specific
    // response, not a transient network condition, so this is treated
    // as a malformed response rather than something a retry would fix.
    case "redirect_invalid":
      return { status: "malformed", failureReason: error.message, resultKind: "failed" };

    // Same reasoning as redirect_invalid: the site's own redirect
    // chain is broken (loops back on itself), not a transient issue.
    case "redirect_loop":
      return { status: "malformed", failureReason: error.message, resultKind: "failed" };

    // An unusually long redirect chain. Could resolve differently on a
    // later attempt if the site's redirect configuration changes, so
    // this stays in the retryable fetch_failed bucket rather than
    // malformed.
    case "too_many_redirects":
      return { status: "fetch_failed", failureReason: error.message, resultKind: "failed" };

    // Classic transient/retryable network conditions.
    case "timeout":
    case "network_error":
      return { status: "fetch_failed", failureReason: error.message, resultKind: "failed" };

    case "rate_limited":
      return { status: "rate_limited", failureReason: error.message, resultKind: "failed" };

    case "auth_required":
      return { status: "authentication_required", failureReason: error.message, resultKind: "failed" };

    // Section 5, explicit: "HTTP 403 alone must NOT automatically mean
    // paywalled." A bare 403 is genuinely ambiguous -- bot-blocking,
    // geo-restriction, and paywalls all commonly return 403 -- so this
    // is routed to needs_review rather than guessed at in either
    // direction (not paywalled, not fetch_failed).
    case "forbidden":
      return { status: "needs_review", failureReason: error.message, resultKind: "needs_review" };

    // 5xx are conventionally retryable.
    case "server_error":
      return { status: "fetch_failed", failureReason: error.message, resultKind: "failed" };

    case "unsupported_content_type":
      return { status: "unsupported", failureReason: error.message, resultKind: "failed" };

    // Section 6/safeFetch's own size cap: not something a retry fixes,
    // and not "malformed" (the content itself may be perfectly valid,
    // just larger than this pipeline is scoped to handle).
    case "response_too_large":
      return { status: "unsupported", failureReason: error.message, resultKind: "failed" };

    // Catch-all for any non-2xx status not covered by a more specific
    // case above (404, 410, 3xx codes safeFetch doesn't treat as
    // redirects, etc). See classifyHttpError for the 402 special case.
    case "http_error":
      return classifyHttpError(error);

    default: {
      // Exhaustiveness guard: if SafeFetchErrorCode ever grows a new
      // member, this fails to compile rather than silently falling
      // through to a wrong status at runtime.
      const _exhaustive: never = error.code;
      return { status: "fetch_failed", failureReason: "An unrecognized fetch error occurred.", resultKind: "failed" };
    }
  }
}

/**
 * Post-fetch, post-metadata-extraction paywall classification for a
 * *successful* fetch (a 2xx response that safeFetch returned as `ok:
 * true`). This is the JSON-LD `isAccessibleForFree: false` path from
 * Section 5 -- the 402/403 paths above only apply when the fetch itself
 * did not return 2xx.
 *
 * Deliberately takes only the one boolean signal `metadataExtraction.ts`
 * is allowed to surface -- no body-text heuristics ("subscribe", login
 * forms, etc) ever reach this function, because `extractIsAccessibleForFree`
 * never produces them in the first place.
 */
export function classifySuccessfulFetchForPaywall(isAccessibleForFree: boolean | null): "paywalled" | null {
  return isAccessibleForFree === false ? "paywalled" : null;
}
