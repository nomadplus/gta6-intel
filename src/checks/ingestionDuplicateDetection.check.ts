/**
 * Regression check for src/lib/ingestion/duplicateDetection.ts.
 *
 * Run with: npx tsx src/checks/ingestionDuplicateDetection.check.ts
 */
import { classifyDuplicateCandidate, type CandidateSourceItem } from "../lib/ingestion/duplicateDetection";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// --- normalizedUrl candidate + same hash -> duplicate ----------------------
{
  const candidates: CandidateSourceItem[] = [
    { id: 1, normalizedUrl: "https://example.com/a", canonicalUrl: null, rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/a", null, HASH_A);
  assert(result.kind === "duplicate" && result.sourceItemId === 1 && result.matchedOn === "normalizedUrl", "normalizedUrl match + same hash -> duplicate, matchedOn normalizedUrl");
}

// --- canonicalUrl candidate + same hash -> duplicate ------------------------
{
  const candidates: CandidateSourceItem[] = [
    { id: 2, normalizedUrl: "https://example.com/different-path", canonicalUrl: "https://example.com/canonical", rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/new-path", "https://example.com/canonical", HASH_A);
  assert(result.kind === "duplicate" && result.sourceItemId === 2 && result.matchedOn === "canonicalUrl", "canonicalUrl match + same hash -> duplicate, matchedOn canonicalUrl");
}

// --- normalizedUrl candidate + different hash -> needs_review ---------------
{
  const candidates: CandidateSourceItem[] = [
    { id: 3, normalizedUrl: "https://example.com/a", canonicalUrl: null, rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/a", null, HASH_B);
  assert(
    result.kind === "needs_review" && result.reason === "hash_mismatch" && result.candidateSourceItemId === 3,
    "normalizedUrl match + different hash -> needs_review (hash_mismatch)"
  );
}

// --- canonicalUrl candidate + different hash -> needs_review -----------------
{
  const candidates: CandidateSourceItem[] = [
    { id: 4, normalizedUrl: "https://example.com/x", canonicalUrl: "https://example.com/canonical", rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/y", "https://example.com/canonical", HASH_B);
  assert(result.kind === "needs_review" && result.reason === "hash_mismatch", "canonicalUrl match + different hash -> needs_review (hash_mismatch)");
}

// --- no candidate -> no_candidate (proceed to source identity) --------------
{
  const result = classifyDuplicateCandidate([], "https://example.com/never-seen", null, HASH_A);
  assert(result.kind === "no_candidate", "empty candidate list -> no_candidate");
}

// --- Candidate with a hash on a totally unrelated URL is never passed in ----
// (Section 9: identical content hash at an unrelated URL must NOT
// auto-deduplicate). This module only ever receives URL-matched
// candidates from its caller -- simulating that contract here by
// confirming a candidate that matches NEITHER field is correctly
// ignored even if it happens to share the hash.
{
  const candidates: CandidateSourceItem[] = [
    { id: 5, normalizedUrl: "https://unrelated.example.com/other-story", canonicalUrl: null, rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/a", null, HASH_A);
  assert(
    result.kind === "no_candidate",
    "a candidate with a matching hash but NO matching URL field is not treated as a duplicate or review case -- same content at an unrelated URL is never auto-collapsed"
  );
}

// --- Multiple matched candidates: lowest id wins deterministically ----------
{
  const candidates: CandidateSourceItem[] = [
    { id: 20, normalizedUrl: "https://example.com/a", canonicalUrl: null, rawContentHash: HASH_B },
    { id: 10, normalizedUrl: "https://example.com/a", canonicalUrl: null, rawContentHash: HASH_A },
  ];
  const result = classifyDuplicateCandidate(candidates, "https://example.com/a", null, HASH_A);
  assert(result.kind === "duplicate" && result.sourceItemId === 10, "when multiple candidates match, the hash-matching one with the lowest id wins deterministically");
}

if (failures > 0) {
  console.error(`\n${failures} duplicate detection check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll duplicate detection checks passed.");
}
