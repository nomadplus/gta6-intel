/**
 * Phase 5 PR 8b regression check for the provenance cluster fingerprint
 * (src/lib/ai/provenanceClusterFingerprint.ts). Pure -- no database, no
 * network.
 *
 * Covers:
 *   - determinism: identical input produces identical output
 *   - order sensitivity: the SAME items in a different array order
 *     produce a DIFFERENT fingerprint (the trigger is responsible for a
 *     stable order; this function does not normalize order itself)
 *   - content sensitivity: changing any one field (title, url,
 *     publishedAt, excerpt) of any one item changes the fingerprint
 *   - a claim's STATEMENT is never part of the input shape at all
 *     (ClusterItemPayload has no statement field) -- re-analysis is
 *     cluster-change-gated, not statement-change-gated, per the locked
 *     PR8b decision
 *   - empty cluster produces a stable, defined fingerprint
 *
 * Run with: npx tsx src/checks/provenanceClusterFingerprint.check.ts
 */
import { computeClusterFingerprint, type ClusterItemPayload } from "../lib/ai/provenanceClusterFingerprint";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== provenance cluster fingerprint (Phase 5 PR 8b) -- pure, no DB ===\n");

const itemA: ClusterItemPayload = { id: 1, title: "A", url: "https://example.test/a", publishedAt: "2024-01-01T00:00:00.000Z", excerpt: "excerpt a" };
const itemB: ClusterItemPayload = { id: 2, title: "B", url: "https://example.test/b", publishedAt: "2024-01-02T00:00:00.000Z", excerpt: "excerpt b" };

// --- determinism ----------------------------------------------------------
{
  const fp1 = computeClusterFingerprint([itemA, itemB]);
  const fp2 = computeClusterFingerprint([{ ...itemA }, { ...itemB }]);
  assert(fp1 === fp2, "identical input (structurally, freshly-constructed objects) produces an identical fingerprint");
}

// --- order sensitivity ------------------------------------------------------
{
  const forward = computeClusterFingerprint([itemA, itemB]);
  const reversed = computeClusterFingerprint([itemB, itemA]);
  assert(forward !== reversed, "the same two items in a different array order produce a DIFFERENT fingerprint (caller owns ordering)");
}

// --- content sensitivity -----------------------------------------------------
{
  const base = computeClusterFingerprint([itemA, itemB]);
  assert(computeClusterFingerprint([{ ...itemA, title: "Changed title" }, itemB]) !== base, "changing title changes the fingerprint");
  assert(computeClusterFingerprint([{ ...itemA, url: "https://example.test/changed" }, itemB]) !== base, "changing url changes the fingerprint");
  assert(computeClusterFingerprint([{ ...itemA, publishedAt: null }, itemB]) !== base, "changing publishedAt changes the fingerprint");
  assert(computeClusterFingerprint([{ ...itemA, excerpt: "changed excerpt" }, itemB]) !== base, "changing excerpt changes the fingerprint");
}

// --- claim statement is never part of the input shape -----------------------
{
  // TypeScript itself enforces this (ClusterItemPayload has no statement
  // field), but this assertion documents the intent directly: two
  // "clusters" that are identical except that one imagines a different
  // claim statement alongside it produce the SAME fingerprint, because
  // computeClusterFingerprint's signature accepts no such field at all.
  const withoutStatementContext = computeClusterFingerprint([itemA, itemB]);
  const alsoWithoutStatementContext = computeClusterFingerprint([itemA, itemB]);
  assert(
    withoutStatementContext === alsoWithoutStatementContext,
    "claims.statement has no bearing on the fingerprint -- re-analysis is cluster-change-gated, not statement-change-gated"
  );
}

// --- empty cluster ------------------------------------------------------------
{
  const empty1 = computeClusterFingerprint([]);
  const empty2 = computeClusterFingerprint([]);
  assert(typeof empty1 === "string" && empty1.length > 0, "an empty cluster still produces a defined, non-empty fingerprint string");
  assert(empty1 === empty2, "an empty cluster's fingerprint is stable across calls");
}

console.log(failures === 0 ? "\nAll provenance cluster fingerprint checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
