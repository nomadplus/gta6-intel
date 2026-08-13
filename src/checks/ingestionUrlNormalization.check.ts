/**
 * Regression check for deterministic URL normalization
 * (src/lib/ingestion/urlNormalization.ts).
 *
 * Run with: npx tsx src/checks/ingestionUrlNormalization.check.ts
 */
import { normalizeUrl } from "../lib/ingestion/urlNormalization";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function assertNormalizesTo(input: string, expected: string, label: string) {
  const result = normalizeUrl(input);
  if (!result.ok) {
    assert(false, `${label} (expected success, got error: ${result.error.code})`);
    return;
  }
  assert(result.normalizedUrl === expected, `${label} -> "${result.normalizedUrl}" (expected "${expected}")`);
}

function assertRejected(input: string, expectedCode: string, label: string) {
  const result = normalizeUrl(input);
  if (result.ok) {
    assert(false, `${label} (expected rejection with code "${expectedCode}", got success: "${result.normalizedUrl}")`);
    return;
  }
  assert(result.error.code === expectedCode, `${label} -> rejected with "${result.error.code}" (expected "${expectedCode}")`);
}

// --- Host / scheme casing ---------------------------------------------
assertNormalizesTo("HTTP://EXAMPLE.COM/path", "http://example.com/path", "uppercase scheme and host are lowercased");

// --- Default ports ------------------------------------------------------
assertNormalizesTo("http://example.com:80/", "http://example.com/", "http default port :80 removed");
assertNormalizesTo("https://example.com:443/", "https://example.com/", "https default port :443 removed");
assertNormalizesTo("http://example.com:8080/", "http://example.com:8080/", "non-default port preserved");
assertNormalizesTo("https://example.com:8443/", "https://example.com:8443/", "non-default https port preserved");

// --- Fragments ------------------------------------------------------------
assertNormalizesTo("https://example.com/page#section-2", "https://example.com/page", "fragment removed");

// --- Trailing slash -------------------------------------------------------
assertNormalizesTo("https://example.com/", "https://example.com/", "root slash is preserved");
assertNormalizesTo("https://example.com", "https://example.com/", "bare origin gets root slash");
assertNormalizesTo("https://example.com/articles/", "https://example.com/articles", "non-root trailing slash removed");
assertNormalizesTo("https://example.com/articles", "https://example.com/articles", "non-root path without trailing slash is unchanged");

// --- Tracking parameters: every approved name, and case-insensitivity ---
const trackingParams = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "spm",
  "CMP",
];
for (const param of trackingParams) {
  assertNormalizesTo(
    `https://example.com/article?${param}=abc123`,
    "https://example.com/article",
    `tracking parameter "${param}" is stripped`
  );
}
assertNormalizesTo(
  "https://example.com/article?UTM_SOURCE=newsletter",
  "https://example.com/article",
  "tracking parameter matching is case-insensitive on the name"
);

// --- Retained / unknown query parameters ----------------------------------
assertNormalizesTo(
  "https://example.com/article?id=42&utm_source=x",
  "https://example.com/article?id=42",
  "unknown query parameter retained, tracking parameter stripped"
);

// --- Deterministic sort order ----------------------------------------------
assertNormalizesTo(
  "https://example.com/article?zeta=1&alpha=2&mid=3",
  "https://example.com/article?alpha=2&mid=3&zeta=1",
  "retained query parameters are sorted deterministically"
);

// --- Duplicate query keys: preserved, not collapsed, order-stable within key
assertNormalizesTo(
  "https://example.com/article?a=2&b=9&a=1",
  "https://example.com/article?a=2&a=1&b=9",
  "duplicate query keys preserved with original relative order, grouped by sort"
);

// --- Query-value serialization: explicit design-judgment coverage ----------
// See the "Design decision" comment block in urlNormalization.ts for the
// full reasoning. These assertions pin down the specific correctness
// properties that decision depends on, so a future change to the
// re-encoding approach can't silently break them.

// %20 and a literal "+" both mean space (application/x-www-form-urlencoded
// convention) and MUST normalize identically -- this is the intended
// equivalence, not an accidental one.
assertNormalizesTo(
  "https://example.com/search?q=hello%20world",
  "https://example.com/search?q=hello+world",
  "%20-encoded space normalizes to '+'"
);
assertNormalizesTo(
  "https://example.com/search?q=hello+world",
  "https://example.com/search?q=hello+world",
  "a literal '+' (meaning space) normalizes the same way as %20"
);

// %2B (an explicitly encoded literal plus) must NOT be conflated with a
// space -- it stays a distinct, round-trippable value.
assertNormalizesTo(
  "https://example.com/search?q=a%2Bb",
  "https://example.com/search?q=a%2Bb",
  "%2B (encoded literal plus) is preserved distinctly, not conflated with space"
);
{
  const spaceResult = normalizeUrl("https://example.com/search?q=a+b");
  const plusResult = normalizeUrl("https://example.com/search?q=a%2Bb");
  assert(
    spaceResult.ok && plusResult.ok && spaceResult.normalizedUrl !== plusResult.normalizedUrl,
    "'a+b' (a b) and 'a%2Bb' (a+b) normalize to two DIFFERENT values -- space and literal plus are never conflated"
  );
}

// Percent-hex case (%2f vs %2F) must collapse to the same normalized
// identity -- both encode the same decoded character.
{
  const lower = normalizeUrl("https://example.com/search?path=a%2fb");
  const upper = normalizeUrl("https://example.com/search?path=a%2Fb");
  assert(
    lower.ok && upper.ok && lower.normalizedUrl === upper.normalizedUrl,
    "percent-hex case ('%2f' vs '%2F') normalizes to the identical value"
  );
}

// Encoded reserved characters (=, &) must stay encoded, never leak out
// as literal delimiters that would change how the query parses.
assertNormalizesTo(
  "https://example.com/search?q=a%3Db%26c",
  "https://example.com/search?q=a%3Db%26c",
  "encoded reserved characters (%3D for '=', %26 for '&') stay encoded, not literal"
);

// --- Invalid input ----------------------------------------------------------
assertRejected("not a url", "malformed", "non-absolute string is rejected as malformed");
assertRejected("::::", "malformed", "garbage input is rejected as malformed");

// --- Unsupported scheme ------------------------------------------------------
assertRejected("ftp://example.com/file.txt", "unsupported_scheme", "ftp scheme is rejected");
assertRejected("javascript:alert(1)", "unsupported_scheme", "javascript scheme is rejected");

// --- Embedded credentials -----------------------------------------------------
assertRejected("https://user:pass@example.com/", "credentials_present", "embedded username/password is rejected");

if (failures > 0) {
  console.error(`\n${failures} URL normalization check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll URL normalization checks passed.");
}
