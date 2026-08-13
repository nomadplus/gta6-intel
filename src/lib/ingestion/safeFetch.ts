/**
 * Safe fetch wrapper for ingestion.
 *
 * This is the one place future ingestion code (RSS polling, manual
 * "fetch this URL" admin actions, etc.) should go to retrieve a remote
 * HTTP resource. It composes the validation primitives from
 * urlSafety.ts with the operational concerns a real fetch needs:
 * manual redirect handling (every hop revalidated), a bounded time
 * budget, a streamed response-size cap, a content-type allowlist, and a
 * typed result shape so callers never have to parse driver error
 * strings or guess what an HTTP status meant.
 *
 * Nothing in this file decides *what* to fetch, matches it to a source,
 * deduplicates it, or stores it -- those are later Phase 4 PRs. This
 * module only answers "can I safely retrieve this URL's bytes, and what
 * came back."
 *
 * ---------------------------------------------------------------------
 * DNS-rebinding limitation (carried forward from urlSafety.ts):
 *
 * Every hop in this module calls `resolveAndValidatePublicHost` before
 * connecting, which validates the hostname's DNS answer *at that
 * moment*. It does not pin that specific IP address to the TCP
 * connection Node's built-in `fetch` subsequently opens -- `fetch`
 * performs its own independent resolution when it actually connects,
 * so a small window exists between "we validated this hostname" and
 * "we connected to it" where an attacker-controlled authoritative DNS
 * server could theoretically change its answer (classic DNS rebinding).
 *
 * For this PR, built-in `fetch` remains the right choice rather than
 * introducing a new low-level HTTP/connection-pinning dependency,
 * because the threat model here is admin-controlled ingestion (RSS
 * feeds and article URLs an administrator or a configured discovery
 * provider points at), not arbitrary third-party input running
 * unsupervised against untrusted user-submitted targets. The blocklist
 * validation still closes the large majority of real-world SSRF paths
 * (cloud metadata endpoints, internal services, loopback, RFC1918).
 * If/when ingestion targets become less trusted (e.g. unmoderated
 * user-submitted URLs), this should be revisited and connection-level
 * pinning should be added -- flagged here rather than silently
 * deferred.
 * ---------------------------------------------------------------------
 */
import {
  validatePublicHttpUrl,
  resolveAndValidatePublicHost,
  type DnsResolver,
} from "./urlSafety";

// ---------------------------------------------------------------------------
// Configuration (exported so callers/tests can see and override the
// defaults rather than relying on magic numbers buried in this file)
// ---------------------------------------------------------------------------

/**
 * Timeout for a single HTTP attempt (the initial request, or any one
 * redirect hop). Chosen as a fraction of the confirmed 300s Vercel
 * Function Max Duration (Fluid Compute enabled) -- see
 * DEFAULT_TOTAL_TIMEOUT_MS below for why this stays far below the
 * function limit rather than approaching it.
 */
export const DEFAULT_PER_HOP_TIMEOUT_MS = 15_000;

/**
 * Total wall-clock budget for one `safeFetch()` call, spanning all of
 * its redirect hops combined. Deliberately a small slice of the 300s
 * function budget: a single ingestion invocation may call `safeFetch`
 * several times in sequence (e.g. checking multiple RSS feeds, or
 * following up a discovered link) and still needs headroom afterward
 * for parsing and database writes. Keeping any one fetch's budget
 * capped at 45s means one slow or hanging target can't starve the rest
 * of an invocation's work.
 */
export const DEFAULT_TOTAL_TIMEOUT_MS = 45_000;

/** Maximum redirect hops followed before giving up. */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Response body size cap, in bytes. This phase is for text/article/feed
 * retrieval, not media -- ~2 MB comfortably covers HTML pages and RSS/
 * Atom feeds without allowing an oversized response to consume
 * function memory or the time budget above.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Content-Type base values (parameters like charset are stripped
 * before matching) that future ingestion logic is allowed to process.
 * Deliberately excludes images, video, archives, executables, PDFs, and
 * any other binary content -- this module is for article/feed text.
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
]);

/**
 * Deliberately not a browser UA -- identifies the bot, points at a
 * contact/info URL, and is centralized here so it changes in one place.
 */
export const DEFAULT_USER_AGENT =
  "GTA6Intel-Ingestion/1.0 (+https://gta6-intel.vercel.app; ingestion bot for The Ledger, a provenance-aware GTA VI claim archive)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SafeFetchErrorCode =
  /** Failed pre-flight validation: scheme, credentials, malformed URL, or a literal blocked hostname/IP. */
  | "invalid_target"
  /** Hostname resolved to a private/blocked address, or failed to resolve at all. */
  | "dns_blocked"
  | "dns_resolution_failed"
  /** Redirect response had a missing or unparseable Location header. */
  | "redirect_invalid"
  /** A redirect target was already visited earlier in this same fetch's chain. */
  | "redirect_loop"
  /** More redirects were required than DEFAULT_MAX_REDIRECTS (or the caller's override) allows. */
  | "too_many_redirects"
  /** Per-hop or total time budget was exceeded. */
  | "timeout"
  /** A network-level failure not covered by the above (connection refused, reset, etc). */
  | "network_error"
  /** HTTP 429. */
  | "rate_limited"
  /** HTTP 401. */
  | "auth_required"
  /** HTTP 403. */
  | "forbidden"
  /** HTTP 5xx. */
  | "server_error"
  /** Response Content-Type was not in the allowlist. */
  | "unsupported_content_type"
  /** Response body exceeded the configured byte cap. */
  | "response_too_large"
  /** Any other non-2xx status not covered by a more specific code above (e.g. 404, 410). */
  | "http_error";

export interface RetryAfterInfo {
  /** The raw header value, kept for logging/debugging. */
  raw: string;
  /** Milliseconds to wait, computed relative to when the response was received. */
  delayMs: number;
}

export interface SafeFetchError {
  code: SafeFetchErrorCode;
  /** Safe, generic message -- never echoes raw driver/network error text. */
  message: string;
  /** The HTTP status that produced this error, when applicable. */
  status?: number;
  /** Present only for 429 and 503 responses with a valid Retry-After header. */
  retryAfter?: RetryAfterInfo;
  /**
   * Short, safe diagnostic string for logging (e.g. the underlying
   * error's `name`). Never the raw error message/stack, and never
   * intended to be shown to an end user.
   */
  diagnostic?: string;
}

export interface SafeFetchSuccess {
  ok: true;
  /** The URL the response actually came from, after following redirects. */
  finalUrl: string;
  status: number;
  /** Content-Type with parameters (e.g. charset) stripped. */
  contentType: string;
  bodyText: string;
  byteLength: number;
  /** URLs visited before the final one, in order, if any redirects were followed. */
  redirectChain: string[];
}

export interface SafeFetchFailure {
  ok: false;
  error: SafeFetchError;
  /** URLs successfully visited before the failure occurred, if any. */
  redirectChain: string[];
}

export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

/**
 * Minimal fetch contract this module depends on -- deliberately just
 * the subset of the global `fetch` signature that's used, so tests can
 * supply a mock without depending on the network.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SafeFetchOptions {
  /** @default DEFAULT_PER_HOP_TIMEOUT_MS */
  perHopTimeoutMs?: number;
  /** @default DEFAULT_TOTAL_TIMEOUT_MS */
  totalTimeoutMs?: number;
  /** @default DEFAULT_MAX_REDIRECTS */
  maxRedirects?: number;
  /** @default DEFAULT_MAX_RESPONSE_BYTES */
  maxResponseBytes?: number;
  /** @default DEFAULT_ALLOWED_CONTENT_TYPES */
  allowedContentTypes?: ReadonlySet<string>;
  /** @default DEFAULT_USER_AGENT */
  userAgent?: string;
  /** Injectable for deterministic tests; defaults to real DNS resolution. */
  dnsResolver?: DnsResolver;
  /** Injectable for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for deterministic timeout/Retry-After tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Strips Content-Type parameters (e.g. "; charset=utf-8") and lowercases. */
export function normalizeContentType(headerValue: string | null): string {
  if (!headerValue) return "";
  return headerValue.split(";")[0]!.trim().toLowerCase();
}

/**
 * Parses a Retry-After header, supporting both the integer-seconds and
 * HTTP-date forms. Returns null for a missing or malformed header --
 * callers should treat that the same as "no Retry-After information",
 * not as an error.
 */
export function parseRetryAfter(headerValue: string | null, now: () => number = Date.now): RetryAfterInfo | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  // Reject a leading "-" outright rather than falling through to
  // Date.parse: some engines' Date.parse accepts unconventional
  // extended-year formats (e.g. treating "-5" as a valid, nonsensical
  // date far in the past) rather than rejecting it, which would
  // otherwise silently turn a malformed negative value into a "valid"
  // Retry-After far in the past.
  if (trimmed.startsWith("-")) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return { raw: trimmed, delayMs: seconds * 1000 };
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return { raw: trimmed, delayMs: Math.max(0, parsedMs - now()) };
}

function errorNameOf(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  return undefined;
}

/** Best-effort, non-throwing attempt to release an unread response body. */
function discardBody(response: Response): void {
  try {
    response.body?.cancel();
  } catch {
    // Nothing meaningful to do if the underlying stream doesn't support
    // cancellation cleanly -- this is purely a resource-hygiene
    // best-effort, not something ingestion logic depends on for
    // correctness.
  }
}

/**
 * Reads a response body via its streaming reader, aborting as soon as
 * the accumulated size exceeds `maxBytes` -- so an oversized response
 * is never fully buffered before the cap is enforced.
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string; byteLength: number } | { ok: false; tooLarge: true }> {
  const body = response.body;
  if (!body) {
    return { ok: true, text: "", byteLength: 0 };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Stop reading immediately -- do not keep accumulating chunks
        // past the cap, and release the underlying stream rather than
        // draining the rest of an oversized body.
        try {
          await reader.cancel();
        } catch {
          // best-effort only
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort only
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8").decode(combined), byteLength: total };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieves `inputUrl`, following redirects manually (revalidating every
 * hop against the SSRF blocklists) up to `maxRedirects` times, within a
 * bounded time and size budget. Always resolves to a typed result --
 * never throws for an expected failure mode (bad target, timeout,
 * oversized/unsupported response, non-2xx status).
 */
export async function safeFetch(inputUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const perHopTimeoutMs = options.perHopTimeoutMs ?? DEFAULT_PER_HOP_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const dnsResolver = options.dnsResolver;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  const deadline = now() + totalTimeoutMs;
  const redirectChain: string[] = [];
  const visited = new Set<string>();
  let currentUrl = inputUrl;

  for (let redirectsFollowed = 0; redirectsFollowed <= maxRedirects; redirectsFollowed++) {
    // --- Pre-flight validation: identical checks on hop 0 and every
    // subsequent redirect target. A previously-safe hostname is never
    // trusted after a redirect. ------------------------------------------
    const targetCheck = validatePublicHttpUrl(currentUrl);
    if (!targetCheck.ok) {
      return {
        ok: false,
        error: { code: "invalid_target", message: "This URL is not a permitted fetch target." },
        redirectChain,
      };
    }

    if (targetCheck.hostnameKind === "hostname") {
      const dnsCheck = await resolveAndValidatePublicHost(targetCheck.url.hostname, dnsResolver);
      if (!dnsCheck.ok) {
        return {
          ok: false,
          error: {
            code: dnsCheck.error.code === "dns_resolution_failed" ? "dns_resolution_failed" : "dns_blocked",
            message: dnsCheck.error.message,
          },
          redirectChain,
        };
      }
    }

    if (visited.has(currentUrl)) {
      return {
        ok: false,
        error: { code: "redirect_loop", message: "This fetch encountered a redirect loop." },
        redirectChain,
      };
    }
    visited.add(currentUrl);

    // --- Time budget ------------------------------------------------------
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return {
        ok: false,
        error: { code: "timeout", message: "The overall fetch time budget was exceeded." },
        redirectChain,
      };
    }
    const hopTimeoutMs = Math.min(perHopTimeoutMs, remainingMs);

    // --- Perform the request ----------------------------------------------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hopTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: Array.from(allowedContentTypes).join(", "),
        },
      });
    } catch (err) {
      const name = errorNameOf(err);
      if (name === "AbortError") {
        return {
          ok: false,
          error: { code: "timeout", message: "The fetch timed out.", diagnostic: name },
          redirectChain,
        };
      }
      return {
        ok: false,
        error: { code: "network_error", message: "A network error occurred while fetching this URL.", diagnostic: name },
        redirectChain,
      };
    } finally {
      clearTimeout(timer);
    }

    // --- Redirect handling --------------------------------------------------
    if (REDIRECT_STATUSES.has(response.status)) {
      discardBody(response);

      if (redirectsFollowed === maxRedirects) {
        return {
          ok: false,
          error: { code: "too_many_redirects", message: "Too many redirects were required to resolve this URL." },
          redirectChain,
        };
      }

      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          error: { code: "redirect_invalid", message: "Redirect response was missing a Location header." },
          redirectChain,
        };
      }

      let resolved: URL;
      try {
        resolved = new URL(location, currentUrl);
      } catch {
        return {
          ok: false,
          error: { code: "redirect_invalid", message: "Redirect response had an invalid Location header." },
          redirectChain,
        };
      }

      redirectChain.push(currentUrl);
      currentUrl = resolved.toString();
      continue;
    }

    // --- Non-redirect, non-2xx statuses -------------------------------------
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now) ?? undefined;
      discardBody(response);

      if (response.status === 429) {
        return {
          ok: false,
          error: { code: "rate_limited", message: "The server responded with 429 Too Many Requests.", status: 429, retryAfter },
          redirectChain,
        };
      }
      if (response.status === 401) {
        return {
          ok: false,
          error: { code: "auth_required", message: "The server responded with 401 Unauthorized.", status: 401 },
          redirectChain,
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          error: { code: "forbidden", message: "The server responded with 403 Forbidden.", status: 403 },
          redirectChain,
        };
      }
      if (response.status >= 500) {
        return {
          ok: false,
          error: {
            code: "server_error",
            message: `The server responded with ${response.status}.`,
            status: response.status,
            retryAfter,
          },
          redirectChain,
        };
      }
      return {
        ok: false,
        error: { code: "http_error", message: `The server responded with ${response.status}.`, status: response.status },
        redirectChain,
      };
    }

    // --- Success status: content-type check before consuming the body -----
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!allowedContentTypes.has(contentType)) {
      discardBody(response);
      return {
        ok: false,
        error: {
          code: "unsupported_content_type",
          message: "This response's Content-Type is not supported for ingestion.",
          status: response.status,
        },
        redirectChain,
      };
    }

    // Fast-path rejection when the server honestly declares an
    // oversized body -- avoids opening the stream at all. This is a
    // best-effort optimization, not the primary defense: Content-Length
    // can be absent or wrong, so the streaming cap below is what
    // actually enforces the limit regardless of this header.
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxResponseBytes) {
      discardBody(response);
      return {
        ok: false,
        error: { code: "response_too_large", message: "The response exceeds the configured size limit.", status: response.status },
        redirectChain,
      };
    }

    const bodyResult = await readBodyWithCap(response, maxResponseBytes);
    if (!bodyResult.ok) {
      return {
        ok: false,
        error: { code: "response_too_large", message: "The response exceeds the configured size limit.", status: response.status },
        redirectChain,
      };
    }

    return {
      ok: true,
      finalUrl: currentUrl,
      status: response.status,
      contentType,
      bodyText: bodyResult.text,
      byteLength: bodyResult.byteLength,
      redirectChain,
    };
  }

  // Unreachable in practice -- the loop always returns via one of the
  // branches above -- but keeps the function's return type honest for
  // the type checker.
  return {
    ok: false,
    error: { code: "too_many_redirects", message: "Too many redirects were required to resolve this URL." },
    redirectChain,
  };
}
