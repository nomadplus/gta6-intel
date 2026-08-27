/**
 * Phase 5 PR 8a regression check for the provenance direction invariant
 * (src/lib/provenanceDirection.ts). Pure -- no database, no network.
 *
 * THE DEFECT THIS PR FIXES (predates PR8a): the admin creation form bound
 * "this item" to sourceItemIdB and the other item to sourceItemIdA, so every
 * relationship created through the UI was STORED as the inverse of what the
 * admin entered. All three readers were correct and faithfully displayed the
 * inverted row; the audit summary was self-consistent with the FORM rather
 * than with storage, so the audit trail described the admin's intent while
 * the database held its opposite.
 *
 * This file locks the VOCABULARY and CONSTANTS half of the invariant. The
 * write-path/read-path agreement half -- the part a pure check structurally
 * cannot reach -- is locked by
 * src/checks/provenanceDirectionRoundTrip.check.ts against a real database.
 *
 * Run with: npx tsx src/checks/provenanceDirection.check.ts
 * (no environment variables required)
 */
import { sourceRelationshipTypeEnum } from "../db/schema";
import {
  provenanceSubjectVerb,
  describeProvenanceLink,
  PROVENANCE_SUBJECT_FIELD,
  PROVENANCE_OBJECT_FIELD,
  PROVENANCE_SUBJECT_COLUMN,
  PROVENANCE_OBJECT_COLUMN,
} from "../lib/provenanceDirection";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== provenance direction invariant (Phase 5 PR 8a) -- pure, no DB ===\n");

// --- 1. Vocabulary completeness ----------------------------------------------
// The guard that stops a future source_relationship_type migration from
// silently degrading a new type to raw-enum rendering: every enum member must
// have a real verb, and the map must not carry a key outside the enum.
const EXPECTED_VERBS: Record<string, string> = {
  original: "is the original source for",
  independent_corroboration: "independently corroborates",
  citation: "cites",
  repetition: "repeats",
  aggregation: "aggregates",
  derivative: "derives from",
  unknown: "has an unknown relationship to",
};

for (const type of sourceRelationshipTypeEnum.enumValues) {
  const verb = provenanceSubjectVerb(type);
  assert(
    verb !== type,
    `'${type}' has a real subject verb, not the raw enum fallback -- a new source_relationship_type must never render as its own slug (got '${verb}')`
  );
}

assert(
  sourceRelationshipTypeEnum.enumValues.length === Object.keys(EXPECTED_VERBS).length,
  `every source_relationship_type enum member is accounted for in this check (enum has ${sourceRelationshipTypeEnum.enumValues.length}, check pins ${Object.keys(EXPECTED_VERBS).length})`
);

for (const key of Object.keys(EXPECTED_VERBS)) {
  assert(
    (sourceRelationshipTypeEnum.enumValues as readonly string[]).includes(key),
    `'${key}' is a real source_relationship_type enum member -- the verb map carries no key outside the enum`
  );
}

// --- 2. Exact verb text, pinned literally ------------------------------------
// The regression guard against a silent rewording that inverts meaning.
for (const [type, expected] of Object.entries(EXPECTED_VERBS)) {
  assert(provenanceSubjectVerb(type) === expected, `'${type}' subject verb text is exactly '${expected}'`);
}

// `original` is the one type whose SUBJECT is the EARLIER, origin item, while
// the four dependence types put the LATER, dependent item in the subject
// position. The A=subject invariant holds for all seven; only the temporal
// meaning of that position differs. Pinned here so the asymmetry is visible
// at the check level, not just in a comment.
assert(
  provenanceSubjectVerb("original") === "is the original source for",
  "'original' reads with the SUBJECT as the ORIGIN ('A is the original source for B') -- inverted temporally relative to citation/repetition/derivative/aggregation, where the subject is the dependent item"
);

// --- 3. Field and column name constants --------------------------------------
// These literal values are the keys createSourceRelationshipSchema parses and
// the columns source_relationships actually has. Binding the admin form to
// these symbols is what makes a future re-swap deliberate rather than
// accidental, so their values must not drift.
assert(PROVENANCE_SUBJECT_FIELD === "sourceItemIdA", "the SUBJECT form field is exactly 'sourceItemIdA'");
assert(PROVENANCE_OBJECT_FIELD === "sourceItemIdB", "the OBJECT form field is exactly 'sourceItemIdB'");
assert(PROVENANCE_SUBJECT_COLUMN === "source_item_id_a", "the SUBJECT column is exactly 'source_item_id_a'");
assert(PROVENANCE_OBJECT_COLUMN === "source_item_id_b", "the OBJECT column is exactly 'source_item_id_b'");
// NOTE: an assertion that the two field constants differ from each other is
// deliberately NOT included -- both are `as const` literal types, so TypeScript
// proves their distinctness at compile time and rejects the comparison as
// unreachable (TS2367). The two exact-value assertions above already pin them
// individually, which implies it.

// --- 4. describeProvenanceLink puts the SUBJECT first -- THE CORE ASSERTION ---
const sentence = describeProvenanceLink("citation", "Source item #7", "source item #9");
assert(
  sentence === "Source item #7 cites source item #9",
  `describeProvenanceLink renders subject-verb-object in that order (got '${sentence}')`
);
assert(
  sentence.startsWith("Source item #7"),
  "describeProvenanceLink's output STARTS with the subject label -- the specific ordering the old audit summary got backwards"
);
assert(
  sentence.endsWith("source item #9"),
  "describeProvenanceLink's output ENDS with the object label"
);
assert(
  describeProvenanceLink("citation", "A", "B") !== describeProvenanceLink("citation", "B", "A"),
  "swapping the subject and object labels produces a DIFFERENT sentence -- provenance is directional and must never read identically both ways"
);

// --- 5. Unrecognized type falls back to the raw value ------------------------
// relationshipType is typed `string` at the query layer, not the enum union,
// so a value outside the known enum must still render something.
assert(
  provenanceSubjectVerb("some_future_type") === "some_future_type",
  "an unrecognized relationship type falls back to the raw value rather than rendering undefined"
);
assert(
  describeProvenanceLink("some_future_type", "A", "B") === "A some_future_type B",
  "describeProvenanceLink inherits the same defensive fallback"
);

console.log(failures === 0 ? "\nAll provenance direction checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
