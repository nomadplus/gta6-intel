/**
 * Regression check for the ingestion safe fetch wrapper
 * (src/lib/ingestion/safeFetch.ts).
 *
 * No live network or DNS access is used. `fetchImpl` and `dnsResolver`
 * are injected in every test via safeFetch's options, and response
 * bodies are built with the real (Node built-in) `Response` /
 * `ReadableStream` classes so the streaming/size-cap behavior is
 * exercised against the actual Web Streams API, not a hand-rolled
 * substitute.
 *
 * Run with: npx tsx src/checks/ingestionSafeFetch.check.ts
 */
import {
  safeFetch,
  parseRetryAfter,
  normalizeContentType,
  type FetchLike,
  type SafeFetchOptions,
} from "../lib/ingestion/safeFetch";
import type { DnsResolver } from "../lib/ingestion/urlSafety";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** DNS resolver that treats every hostname as resolving to a public address. */
function publicResolver(): DnsResolver {
  return {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => {
      throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
    },
  };
}

/** DNS resolver that always resolves to a private/blocked address. */
function privateResolver(): DnsResolver {
  return {
    resolve4: async () => ["10.0.0.5"],
    resolve6: async () => {
      throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
    },
  };
}

/** DNS resolver returning a mix of public and private addresses. */
function mixedResolver(): DnsResolver {
  return {
    resolve4: async () => ["93.184.216.34", "10.0.0.5"],
    resolve6: async () => [],
  };
}

/**
 * A scripted fetchImpl: each call pops and invokes the next step in
 * `steps`, in order. Asserts (via the returned `callCount` getter) how
 * many times the network layer was actually reached, so tests can
 * confirm pre-flight rejections short-circuit before any request.
 */
function scriptedFetch(steps: Array<(url: string, init: RequestInit) => Response>): {
  fetchImpl: FetchLike;
  callCount: () => number;
  calledUrls: () => string[];
} {
  let index = 0;
  const calledUrls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calledUrls.push(url);
    const step = steps[index];
    index++;
    if (!step) {
      throw new Error(`scriptedFetch: no step programmed for call #${index} (url: ${url})`);
    }
    return step(url, init);
  };
  return { fetchImpl, callCount: () => calledUrls.length, calledUrls: () => calledUrls };
}

function redirectResponse(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function textResponse(status: number, body: string, contentType = "text/html", extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } });
}

function statusOnlyResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: extraHeaders });
}

/**
 * A response whose body is produced lazily, chunk by chunk, via a
 * custom ReadableStream `pull` callback -- so we can assert how many
 * chunks were actually consumed by the reader (proof the implementation
 * doesn't fully buffer an oversized body before enforcing the cap).
 */
function laggyBodyResponse(
  chunkSize: number,
  chunkCount: number,
  contentType = "text/html"
): { response: Response; pulledChunks: () => number } {
  let pulled = 0;
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      pulled++;
      emitted++;
      controller.enqueue(new Uint8Array(chunkSize).fill(97));
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": contentType } }),
    pulledChunks: () => pulled,
  };
}

async function run(inputUrl: string, opts: Partial<SafeFetchOptions>) {
  return safeFetch(inputUrl, {
    dnsResolver: publicResolver(),
    now: Date.now,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

function testRetryAfter() {
  const fixedNow = () => new Date("2026-01-01T00:00:00.000Z").getTime();

  {
    const result = parseRetryAfter("120", fixedNow);
    assert(result !== null && result.delayMs === 120_000, "Retry-After: numeric seconds parsed correctly");
  }
  {
    const result = parseRetryAfter("Thu, 01 Jan 2026 00:02:00 GMT", fixedNow);
    assert(result !== null && result.delayMs === 120_000, "Retry-After: HTTP-date form parsed correctly");
  }
  {
    const result = parseRetryAfter("not-a-valid-value", fixedNow);
    assert(result === null, "Retry-After: malformed header returns null rather than throwing");
  }
  {
    const result = parseRetryAfter(null, fixedNow);
    assert(result === null, "Retry-After: missing header returns null");
  }
  {
    const result = parseRetryAfter("-5", fixedNow);
    assert(result === null, "Retry-After: negative seconds treated as malformed");
  }
}

// ---------------------------------------------------------------------------
// normalizeContentType
// ---------------------------------------------------------------------------

function testContentTypeNormalization() {
  assert(normalizeContentType("text/html; charset=utf-8") === "text/html", "Content-Type: charset parameter stripped");
  assert(normalizeContentType("APPLICATION/RSS+XML") === "application/rss+xml", "Content-Type: case-insensitive matching");
  assert(normalizeContentType(null) === "", "Content-Type: missing header normalizes to empty string");
}

// ---------------------------------------------------------------------------
// SSRF integration
// ---------------------------------------------------------------------------

async function testSsrfIntegration() {
  {
    const { fetchImpl, callCount } = scriptedFetch([]);
    const result = await safeFetch("http://127.0.0.1/admin", { fetchImpl, dnsResolver: publicResolver() });
    assert(!result.ok && result.error.code === "invalid_target", "SSRF: literal blocked IP target rejected");
    assert(callCount() === 0, "SSRF: literal blocked IP target rejected before any network call");
  }
  {
    const { fetchImpl, callCount } = scriptedFetch([]);
    const result = await safeFetch("http://internal.example/", { fetchImpl, dnsResolver: privateResolver() });
    assert(!result.ok && result.error.code === "dns_blocked", "SSRF: hostname resolving to a private IP rejected");
    assert(callCount() === 0, "SSRF: DNS-blocked hostname rejected before any network call");
  }
  {
    const { fetchImpl, callCount } = scriptedFetch([]);
    const result = await safeFetch("http://mixed.example/", { fetchImpl, dnsResolver: mixedResolver() });
    assert(!result.ok && result.error.code === "dns_blocked", "SSRF: hostname resolving to a mix of public/private addresses rejected entirely");
    assert(callCount() === 0, "SSRF: mixed-DNS hostname rejected before any network call");
  }
  {
    // Redirect from a validated public target straight to a private IP:
    // must be caught on revalidation of the *new* hop, not trusted
    // because the first hop was safe.
    const { fetchImpl, calledUrls } = scriptedFetch([
      (url) => redirectResponse(302, "http://169.254.169.254/latest/meta-data"),
    ]);
    const result = await safeFetch("http://public.example/start", { fetchImpl, dnsResolver: publicResolver() });
    assert(!result.ok && result.error.code === "invalid_target", "SSRF: redirect target is revalidated and blocked (cloud metadata address)");
    assert(calledUrls().length === 1, "SSRF: the blocked redirect target itself was never fetched");
  }
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

async function testRedirects() {
  {
    const { fetchImpl } = scriptedFetch([
      (url) => redirectResponse(302, "http://public.example/final"),
      (url) => textResponse(200, "<html>ok</html>"),
    ]);
    const result = await run("http://public.example/start", { fetchImpl });
    assert(result.ok && result.finalUrl === "http://public.example/final", "Redirects: simple valid redirect is followed to completion");
    assert(result.ok && result.redirectChain.length === 1 && result.redirectChain[0] === "http://public.example/start", "Redirects: redirect chain records the visited hop");
  }
  {
    const { fetchImpl } = scriptedFetch([
      (url) => redirectResponse(301, "/articles/final"),
      (url) => textResponse(200, "<html>ok</html>"),
    ]);
    const result = await run("http://public.example/start", { fetchImpl });
    assert(result.ok && result.finalUrl === "http://public.example/articles/final", "Redirects: relative Location header resolved against the current URL");
  }
  {
    const { fetchImpl, callCount } = scriptedFetch([(url) => redirectResponse(302, "http://127.0.0.1/steal")]);
    const result = await safeFetch("http://public.example/start", { fetchImpl, dnsResolver: publicResolver() });
    assert(!result.ok && result.error.code === "invalid_target", "Redirects: redirect to localhost/private IP is blocked");
    assert(callCount() === 1, "Redirects: the blocked target was never actually fetched");
  }
  {
    const { fetchImpl } = scriptedFetch([(url) => redirectResponse(302, "http://[::ffff:127.0.0.1]/steal")]);
    const result = await run("http://public.example/start", { fetchImpl });
    assert(!result.ok && result.error.code === "invalid_target", "Redirects: redirect to an IPv4-mapped private IPv6 literal is blocked");
  }
  {
    const { fetchImpl } = scriptedFetch([
      (url) => redirectResponse(302, "http://public.example/b"),
      (url) => redirectResponse(302, "http://public.example/a"),
    ]);
    const result = await run("http://public.example/a", { fetchImpl });
    assert(!result.ok && result.error.code === "redirect_loop", "Redirects: a redirect loop is detected and rejected");
  }
  {
    // 6 redirects with maxRedirects=5 -> should fail on the 6th.
    const { fetchImpl } = scriptedFetch([
      (url) => redirectResponse(302, "http://public.example/1"),
      (url) => redirectResponse(302, "http://public.example/2"),
      (url) => redirectResponse(302, "http://public.example/3"),
      (url) => redirectResponse(302, "http://public.example/4"),
      (url) => redirectResponse(302, "http://public.example/5"),
      (url) => redirectResponse(302, "http://public.example/6"),
    ]);
    const result = await run("http://public.example/0", { fetchImpl, maxRedirects: 5 });
    assert(!result.ok && result.error.code === "too_many_redirects", "Redirects: exceeding the hop limit (>5) fails with too_many_redirects");
  }
  {
    // Exactly 5 redirects, then success -- should be allowed.
    const { fetchImpl } = scriptedFetch([
      (url) => redirectResponse(302, "http://public.example/1"),
      (url) => redirectResponse(302, "http://public.example/2"),
      (url) => redirectResponse(302, "http://public.example/3"),
      (url) => redirectResponse(302, "http://public.example/4"),
      (url) => redirectResponse(302, "http://public.example/5"),
      (url) => textResponse(200, "<html>ok</html>"),
    ]);
    const result = await run("http://public.example/0", { fetchImpl, maxRedirects: 5 });
    assert(result.ok === true, "Redirects: exactly 5 redirects (at the limit) succeeds");
  }
  {
    const { fetchImpl } = scriptedFetch([(url) => redirectResponse(302, "")]);
    const result = await run("http://public.example/start", { fetchImpl });
    // An empty Location header value is treated as missing.
    assert(!result.ok && result.error.code === "redirect_invalid", "Redirects: missing/empty Location header fails with redirect_invalid");
  }
}

// ---------------------------------------------------------------------------
// Timeout / network
// ---------------------------------------------------------------------------

async function testTimeoutAndNetwork() {
  {
    const fetchImpl: FetchLike = async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    const result = await run("http://public.example/slow", { fetchImpl, perHopTimeoutMs: 20, totalTimeoutMs: 1000 });
    assert(!result.ok && result.error.code === "timeout", "Timeout: an aborted request produces a typed timeout failure");
  }
  {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await run("http://public.example/broken", { fetchImpl });
    assert(!result.ok && result.error.code === "network_error", "Network: a generic network failure produces a safe typed failure result");
    assert(!result.ok && !("stack" in (result.error as object)), "Network: the typed failure does not leak a raw error stack");
  }
}

// ---------------------------------------------------------------------------
// Size limit
// ---------------------------------------------------------------------------

async function testSizeLimit() {
  const cap = 1000;

  {
    const { response } = laggyBodyResponse(100, 5); // 500 bytes total, under cap
    const fetchImpl: FetchLike = async () => response;
    const result = await run("http://public.example/small", { fetchImpl, maxResponseBytes: cap });
    assert(result.ok && result.byteLength === 500, "Size: a body under the cap succeeds and reports the correct byte length");
  }
  {
    const { response } = laggyBodyResponse(100, 10); // exactly 1000 bytes
    const fetchImpl: FetchLike = async () => response;
    const result = await run("http://public.example/exact", { fetchImpl, maxResponseBytes: cap });
    assert(result.ok && result.byteLength === cap, "Size: a body exactly at the cap succeeds");
  }
  {
    const { response, pulledChunks } = laggyBodyResponse(100, 50); // 5000 bytes, well over cap
    const fetchImpl: FetchLike = async () => response;
    const result = await run("http://public.example/big", { fetchImpl, maxResponseBytes: cap });
    assert(!result.ok && result.error.code === "response_too_large", "Size: a body over the cap fails with response_too_large");
    assert(pulledChunks() < 50, "Size: an oversized body is not fully buffered/consumed before the cap is enforced");
  }
  {
    // Declared Content-Length alone exceeds the cap -- should reject
    // without ever pulling from the stream.
    const { response, pulledChunks } = laggyBodyResponse(100, 50);
    const withLength = new Response(response.body, {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "5000" },
    });
    const fetchImpl: FetchLike = async () => withLength;
    const result = await run("http://public.example/declared-big", { fetchImpl, maxResponseBytes: cap });
    assert(!result.ok && result.error.code === "response_too_large", "Size: an honestly-declared oversized Content-Length is rejected fast");
    // A ReadableStream's default queuing strategy eagerly invokes
    // `pull()` once after construction (to fill its highWaterMark),
    // independent of whether anything ever reads from it -- so "at
    // most 1" (the unavoidable eager fill), not "0", is the correct
    // bar for "the fast path never deliberately read from the stream".
    assert(pulledChunks() <= 1, "Size: fast-path Content-Length rejection never deliberately reads from the stream");
  }
}

// ---------------------------------------------------------------------------
// Content-Type
// ---------------------------------------------------------------------------

async function testContentType() {
  const approved = ["text/html", "application/xhtml+xml", "application/rss+xml", "application/atom+xml", "application/xml", "text/xml"];

  for (const type of approved) {
    const fetchImpl: FetchLike = async () => textResponse(200, "<x/>", type);
    const result = await run(`http://public.example/${type.replace(/[/+]/g, "-")}`, { fetchImpl });
    assert(result.ok === true, `Content-Type: approved type "${type}" is accepted`);
  }

  {
    const fetchImpl: FetchLike = async () => textResponse(200, "<html/>", "text/html; charset=utf-8");
    const result = await run("http://public.example/charset", { fetchImpl });
    assert(result.ok === true, "Content-Type: approved type with a charset parameter is accepted");
  }

  {
    const fetchImpl: FetchLike = async () => textResponse(200, "binarydata", "image/png");
    const result = await run("http://public.example/image", { fetchImpl });
    assert(!result.ok && result.error.code === "unsupported_content_type", "Content-Type: an unsupported binary/media type is rejected");
  }
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

async function testStatuses() {
  {
    const fetchImpl: FetchLike = async () => textResponse(200, "<html>ok</html>");
    const result = await run("http://public.example/ok", { fetchImpl });
    assert(result.ok === true && result.status === 200, "Statuses: 200 is treated as success");
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(401);
    const result = await run("http://public.example/401", { fetchImpl });
    assert(!result.ok && result.error.code === "auth_required" && result.error.status === 401, "Statuses: 401 maps to auth_required");
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(403);
    const result = await run("http://public.example/403", { fetchImpl });
    assert(!result.ok && result.error.code === "forbidden" && result.error.status === 403, "Statuses: 403 maps to forbidden");
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(429, { "retry-after": "30" });
    const result = await run("http://public.example/429", { fetchImpl });
    assert(!result.ok && result.error.code === "rate_limited" && result.error.status === 429, "Statuses: 429 maps to rate_limited");
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(503);
    const result = await run("http://public.example/503", { fetchImpl });
    assert(!result.ok && result.error.code === "server_error" && result.error.status === 503, "Statuses: representative 5xx (503) maps to server_error");
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(404);
    const result = await run("http://public.example/404", { fetchImpl });
    assert(!result.ok && result.error.code === "http_error" && result.error.status === 404, "Statuses: an unenumerated status (404) still produces a typed http_error rather than being unhandled");
  }
}

// ---------------------------------------------------------------------------
// Retry-After integration (via the 429/503 paths)
// ---------------------------------------------------------------------------

async function testRetryAfterIntegration() {
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(429, { "retry-after": "15" });
    const result = await run("http://public.example/429-numeric", { fetchImpl });
    assert(
      !result.ok && result.error.retryAfter?.delayMs === 15_000,
      "Retry-After integration: numeric seconds surfaced as structured metadata on a 429"
    );
  }
  {
    const fixedNow = () => new Date("2026-01-01T00:00:00.000Z").getTime();
    const fetchImpl: FetchLike = async () => statusOnlyResponse(503, { "retry-after": "Thu, 01 Jan 2026 00:01:00 GMT" });
    const result = await run("http://public.example/503-date", { fetchImpl, now: fixedNow });
    assert(
      !result.ok && result.error.retryAfter?.delayMs === 60_000,
      "Retry-After integration: HTTP-date form surfaced as structured metadata on a 503"
    );
  }
  {
    const fetchImpl: FetchLike = async () => statusOnlyResponse(429, { "retry-after": "garbage" });
    const result = await run("http://public.example/429-malformed", { fetchImpl });
    assert(
      !result.ok && result.error.retryAfter === undefined,
      "Retry-After integration: a malformed header on a 429 leaves retryAfter absent rather than throwing"
    );
  }
}

// ---------------------------------------------------------------------------
// Run everything
// ---------------------------------------------------------------------------

async function runAll() {
  testRetryAfter();
  testContentTypeNormalization();
  await testSsrfIntegration();
  await testRedirects();
  await testTimeoutAndNetwork();
  await testSizeLimit();
  await testContentType();
  await testStatuses();
  await testRetryAfterIntegration();

  if (failures > 0) {
    console.error(`\n${failures} safe fetch check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll safe fetch checks passed.");
  }
}

runAll();
