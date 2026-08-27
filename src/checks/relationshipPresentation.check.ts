/**
 * Regression check for Phase 5 PR 7's directional relationship-display
 * fix (src/lib/relationshipDisplay.ts's relatedClaimLabel). Pure -- no
 * database, no network.
 *
 * This is the PRE-EXISTING defect PR7 fixes as an in-scope prerequisite:
 * getRelatedClaims returned a relationship row for the viewed claim
 * without indicating which side of the stored (claim_id_a, claim_id_b)
 * pair it occupied, and neither admin nor public consumer accounted for
 * that side -- so roughly half of all directional (subsumes/refines)
 * relationships displayed with their meaning INVERTED, and the two
 * consumers additionally disagreed with each other (the public
 * component always rendered "refines" in the passive voice; the admin
 * page always rendered the raw enum value).
 *
 * Covers all 10 (relationshipType x viewedClaimIsA) combinations, the
 * symmetric-types-ignore-side invariant, and the unrecognized-type
 * fallback.
 *
 * Run with: npx tsx src/checks/relationshipPresentation.check.ts
 */
import { relatedClaimLabel } from "../lib/relationshipDisplay";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== directional relationship display fix (Phase 5 PR 7) -- pure, no DB ===\n");

// --- symmetric types: identical output regardless of side ---------------------
for (const type of ["equivalent", "related", "contradicts"]) {
  const asA = relatedClaimLabel(type, true);
  const asB = relatedClaimLabel(type, false);
  assert(asA === asB, `'${type}' produces the IDENTICAL label regardless of viewedClaimIsA (canonicalization makes the stored side meaningless for symmetric types) -- got '${asA}' vs '${asB}'`);
}
assert(relatedClaimLabel("equivalent", true) === "Equivalent to", "'equivalent' label text");
assert(relatedClaimLabel("related", true) === "Related to", "'related' label text");
assert(relatedClaimLabel("contradicts", true) === "Contradicts", "'contradicts' label text");

// --- directional types: THE CORE FIX -- distinct label per side ---------------
assert(relatedClaimLabel("subsumes", true) === "Subsumes", "viewed claim IS claim_id_a for 'subsumes' -> active voice 'Subsumes' (this claim does the subsuming)");
assert(relatedClaimLabel("subsumes", false) === "Subsumed by", "viewed claim is claim_id_b for 'subsumes' -> 'Subsumed by' (the OTHER claim shown in the row does the subsuming)");
assert(relatedClaimLabel("refines", true) === "Refines", "viewed claim IS claim_id_a for 'refines' -> active voice 'Refines' (this claim does the refining)");
assert(relatedClaimLabel("refines", false) === "Refined by", "viewed claim is claim_id_b for 'refines' -> 'Refined by' (the OTHER claim shown in the row does the refining)");

// Regression guard against the specific pre-existing defect: 'refines'
// must NOT always render in the passive voice regardless of side (the
// public component's old, always-passive behavior).
assert(
  relatedClaimLabel("refines", true) !== relatedClaimLabel("refines", false),
  "'refines' produces a DIFFERENT label depending on side -- the defect this PR fixes was rendering it identically (always passive) regardless of orientation"
);
assert(
  relatedClaimLabel("subsumes", true) !== relatedClaimLabel("subsumes", false),
  "'subsumes' produces a DIFFERENT label depending on side"
);

// --- unrecognized relationshipType: defensive fallback to raw value -----------
assert(relatedClaimLabel("some_future_type", true) === "some_future_type", "an unrecognized relationshipType falls back to the raw value (defensive -- relationshipType is typed string at the query layer, not the enum union)");
assert(relatedClaimLabel("some_future_type", false) === "some_future_type", "the fallback is identical regardless of side, since an unknown type carries no known directional semantics");

console.log(failures === 0 ? "\nAll relationship-presentation checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
