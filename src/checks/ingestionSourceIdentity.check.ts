/**
 * Regression check for src/lib/ingestion/sourceIdentity.ts.
 *
 * Run with: npx tsx src/checks/ingestionSourceIdentity.check.ts
 */
import { proposeSourceIdentity, extractHostname, type CandidateSource } from "../lib/ingestion/sourceIdentity";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// --- One exact hostname match -> proposed -----------------------------
{
  const candidates: CandidateSource[] = [
    { id: 1, homepageUrl: "https://ign.com/" },
    { id: 2, homepageUrl: "https://kotaku.com/" },
  ];
  const result = proposeSourceIdentity("ign.com", candidates);
  assert(result.kind === "proposed" && result.sourceId === 1, "exact hostname match -> proposed with the matching source id");
}

// --- No match -> no_match --------------------------------------------
{
  const candidates: CandidateSource[] = [{ id: 1, homepageUrl: "https://ign.com/" }];
  const result = proposeSourceIdentity("totallyunknownsite.com", candidates);
  assert(result.kind === "no_match", "hostname with no candidate match -> no_match");
}

// --- Ambiguous / multiple matches -> ambiguous ---------------------------
{
  const candidates: CandidateSource[] = [
    { id: 5, homepageUrl: "https://example.com/" },
    { id: 9, homepageUrl: "https://example.com/some-other-page" }, // same hostname, different path -- still counts
  ];
  const result = proposeSourceIdentity("example.com", candidates);
  assert(
    result.kind === "ambiguous" && result.matchedSourceIds.length === 2 && result.matchedSourceIds[0] === 5 && result.matchedSourceIds[1] === 9,
    "two sources sharing a hostname -> ambiguous, with sorted matched ids"
  );
}

// --- No inference of trustworthiness: matching never ranks/orders by anything but id ----
{
  const candidates: CandidateSource[] = [
    { id: 100, homepageUrl: "https://news.example.com/" },
    { id: 3, homepageUrl: "https://news.example.com/" },
  ];
  const result = proposeSourceIdentity("news.example.com", candidates);
  assert(result.kind === "ambiguous", "ambiguous match carries no trust signal -- both ids surfaced equally");
  if (result.kind === "ambiguous") {
    assert(result.matchedSourceIds[0] === 3, "matched ids are sorted ascending for determinism, not by any trust heuristic");
  }
}

// --- Sources with malformed/missing homepage_url are excluded, not errors --
{
  const candidates: CandidateSource[] = [
    { id: 1, homepageUrl: null },
    { id: 2, homepageUrl: "not a url at all" },
    { id: 3, homepageUrl: "https://real-match.com/" },
  ];
  const result = proposeSourceIdentity("real-match.com", candidates);
  assert(result.kind === "proposed" && result.sourceId === 3, "null/malformed homepage_url candidates are excluded from matching, not thrown on");
}

// --- extractHostname -------------------------------------------------------
assert(extractHostname("https://Example.COM/path") === "example.com", "extractHostname lowercases the hostname");
assert(extractHostname("not a url") === null, "extractHostname returns null for a malformed URL rather than throwing");

// --- Known, documented limitation: no www stripping -------------------------
{
  const candidates: CandidateSource[] = [{ id: 1, homepageUrl: "https://www.example.com/" }];
  const result = proposeSourceIdentity("example.com", candidates); // no "www."
  assert(result.kind === "no_match", "www.example.com source homepage does NOT match a bare example.com fetch hostname -- documented conservative limitation, not a bug");
}

if (failures > 0) {
  console.error(`\n${failures} source identity check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll source identity checks passed.");
}
