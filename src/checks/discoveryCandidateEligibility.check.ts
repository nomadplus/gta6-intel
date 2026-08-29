/**
 * Regression check for the pure discovery-candidate admissibility fold
 * (src/lib/discovery/candidateEligibility.ts) and the URL validation it
 * relies on (reused verbatim from src/lib/ingestion/urlNormalization.ts --
 * not reimplemented here).
 *
 * This is the PURE half of Phase 6 PR 6.1's check coverage -- no
 * database, no "server-only" import. See discoveryCandidateLedger.check.ts
 * for the DB-backed half (trigger behavior, replay, promotion).
 *
 * Run with: npx tsx src/checks/discoveryCandidateEligibility.check.ts
 */
import { normalizeUrl } from "../lib/ingestion/urlNormalization";
import { ADMISSIBILITY_RANK, foldAdmissibility } from "../lib/discovery/candidateEligibility";
import type { DiscoveryAdmissibility } from "../lib/discovery/types";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// --- URL validation reuse (a discovery sighting with an unparseable/
// unsupported URL must be rejected the same way manual ingestion is) -----

const VALID_URL = "https://example.com/some-article";
const INVALID_URLS: Array<[string, string]> = [
  ["not a url", "malformed"],
  ["ftp://example.com/file.txt", "unsupported_scheme"],
  ["javascript:alert(1)", "unsupported_scheme"],
  ["https://user:pass@example.com/", "credentials_present"],
];

{
  const result = normalizeUrl(VALID_URL);
  assert(result.ok, "a syntactically valid http(s) URL normalizes successfully");
}

for (const [input, expectedCode] of INVALID_URLS) {
  const result = normalizeUrl(input);
  assert(
    !result.ok && result.error.code === expectedCode,
    `"${input}" is rejected as "${expectedCode}" -- a discovery sighting with this URL creates no candidate/observation`
  );
}

// --- Admissibility fold: all nine current x incoming combinations -------

const LEVELS: DiscoveryAdmissibility[] = ["excluded", "held", "eligible"];

for (const current of LEVELS) {
  for (const incoming of LEVELS) {
    const result = foldAdmissibility(current, incoming);
    const expected = ADMISSIBILITY_RANK[incoming] > ADMISSIBILITY_RANK[current] ? incoming : current;
    assert(
      result === expected,
      `fold(current="${current}", incoming="${incoming}") -> "${result}" (expected "${expected}")`
    );
  }
}

// Explicit spot-checks for the three qualitatively distinct outcomes, so
// a future refactor of ADMISSIBILITY_RANK can't silently invert the
// intended direction without a check failing on human-readable intent,
// not just the generated matrix above.
assert(foldAdmissibility("excluded", "held") === "held", "excluded + held observation -> raises to held");
assert(foldAdmissibility("held", "eligible") === "eligible", "held + eligible observation -> raises to eligible");
assert(foldAdmissibility("eligible", "excluded") === "eligible", "eligible + excluded observation -> stays eligible (never lowered)");
assert(foldAdmissibility("excluded", "excluded") === "excluded", "excluded + excluded observation -> stays excluded");

// --- Rank ordering itself -------------------------------------------------

assert(
  ADMISSIBILITY_RANK.excluded < ADMISSIBILITY_RANK.held && ADMISSIBILITY_RANK.held < ADMISSIBILITY_RANK.eligible,
  "ADMISSIBILITY_RANK strictly orders excluded < held < eligible"
);

if (failures > 0) {
  console.error(`\n${failures} discovery candidate eligibility check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll discovery candidate eligibility checks passed.");
}
