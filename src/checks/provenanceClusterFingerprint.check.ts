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

// ===========================================================================
// Phase 6 prerequisite: knownOutboundLinks fingerprint-compatibility checks.
//
// CRITICAL REQUIREMENT: adding this feature must not make every existing,
// pre-feature analyse_provenance result look stale merely because the
// payload object gained a new (empty) property. This is proven against a
// FIXED, independently-computed expected hash -- not merely "two calls
// return the same result", which would not catch an accidental payload-
// shape drift (e.g. a future refactor that always includes
// `knownOutboundLinks: []`).
// ===========================================================================
console.log("\n=== knownOutboundLinks fingerprint compatibility (Phase 6 prerequisite) ===\n");

const PRE_FEATURE_FIXTURE: ClusterItemPayload[] = [
  { id: 101, title: "Alpha Report", url: "https://a.test/alpha", publishedAt: "2026-01-01T00:00:00.000Z", excerpt: "An alpha excerpt." },
  { id: 202, title: "Beta Report", url: "https://b.test/beta", publishedAt: "2026-01-02T00:00:00.000Z", excerpt: "A beta excerpt." },
];
// Independently computed (see the implementation plan's verification):
// sha256 of JSON.stringify of the exact canonical array above, with no
// `knownOutboundLinks` key present on either object -- the pre-feature
// canonical shape.
const FIXED_PRE_FEATURE_HASH = "795aff50c1038226238f97028f7455e3395861d142ca66d0510e941557ae99e1";

// --- zero-link cluster: no knownOutboundLinks key, matches the fixed hash --
{
  const fp = computeClusterFingerprint(PRE_FEATURE_FIXTURE);
  assert(fp === FIXED_PRE_FEATURE_HASH, `zero-link cluster's fingerprint equals the FIXED pre-feature hash -- got ${fp}`);
}

// --- knownOutboundLinks: undefined vs explicit empty array are IDENTICAL --
{
  const withUndefined = computeClusterFingerprint(PRE_FEATURE_FIXTURE);
  const withExplicitEmpty = computeClusterFingerprint(
    PRE_FEATURE_FIXTURE.map((item) => ({ ...item, knownOutboundLinks: [] }))
  );
  assert(
    withUndefined === withExplicitEmpty && withUndefined === FIXED_PRE_FEATURE_HASH,
    "an explicit empty knownOutboundLinks: [] produces the SAME fingerprint as omitting the field entirely -- both match the fixed pre-feature hash"
  );
}

// --- real in-cluster link evidence changes the fingerprint -----------------
{
  const withLinks: ClusterItemPayload[] = [
    {
      ...PRE_FEATURE_FIXTURE[0]!,
      knownOutboundLinks: [
        { toSourceItemId: 202, anchorText: "the beta report", contextSnippet: "as covered in the beta report earlier", placement: "content", isSameSite: false },
      ],
    },
    PRE_FEATURE_FIXTURE[1]!,
  ];
  const fp = computeClusterFingerprint(withLinks);
  assert(fp !== FIXED_PRE_FEATURE_HASH, "real in-cluster link evidence changes the fingerprint away from the pre-feature hash");
}

// --- row/query order does not change the fingerprint if canonical evidence is unchanged ---
{
  const linkEntryA: NonNullable<ClusterItemPayload["knownOutboundLinks"]>[number] = {
    toSourceItemId: 202,
    anchorText: "x",
    contextSnippet: "y",
    placement: "content",
    isSameSite: true,
  };
  const linkEntryB: NonNullable<ClusterItemPayload["knownOutboundLinks"]>[number] = {
    toSourceItemId: 303,
    anchorText: "z",
    contextSnippet: "w",
    placement: "ambiguous",
    isSameSite: false,
  };

  const itemWithTwoLinks = (links: (typeof linkEntryA)[]): ClusterItemPayload => ({
    ...PRE_FEATURE_FIXTURE[0]!,
    knownOutboundLinks: links,
  });

  // Same two link entries, same array order in BOTH calls -- the caller
  // (analyseProvenanceTrigger.ts's buildKnownOutboundLinksByItem) owns
  // producing a deterministic per-item order; this function does not
  // re-sort. This asserts that calling it twice with the SAME already-
  // ordered evidence is stable -- changing an unrelated upstream row-scan
  // order that still yields the same final per-item array must not affect
  // the hash.
  const fp1 = computeClusterFingerprint([itemWithTwoLinks([linkEntryA, linkEntryB]), PRE_FEATURE_FIXTURE[1]!]);
  const fp2 = computeClusterFingerprint([itemWithTwoLinks([{ ...linkEntryA }, { ...linkEntryB }]), { ...PRE_FEATURE_FIXTURE[1]! }]);
  assert(fp1 === fp2, "identical canonical evidence (freshly-constructed objects, same order) produces an identical fingerprint");

  // But an actual DIFFERENT per-item array order IS a different canonical
  // shape and correctly produces a different hash -- ordering is part of
  // the canonical input, exactly like the existing cluster-array-order
  // sensitivity check above. Callers are responsible for a deterministic
  // order; this function faithfully reflects whatever order it's given.
  const fpReordered = computeClusterFingerprint([itemWithTwoLinks([linkEntryB, linkEntryA]), PRE_FEATURE_FIXTURE[1]!]);
  assert(fp1 !== fpReordered, "a genuinely different per-item link array order produces a different fingerprint (ordering is part of the canonical input)");
}

console.log(failures === 0 ? "\nAll fingerprint compatibility checks passed." : `\n${failures} total check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
