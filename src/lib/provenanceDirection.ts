/**
 * Phase 5 PR 8a. THE canonical statement of provenance direction for
 * `source_relationships`, and the ONE implementation of its labelling.
 *
 * INVARIANT (locked, Phase 5 PR 8a):
 *   source_item_id_a is the SUBJECT of the relationship.
 *   source_item_id_b is the OBJECT.
 *   A row (a = 7, b = 9, 'citation') asserts "source item 7 cites source item 9".
 *
 * This table is deliberately NOT canonicalized (unlike claim_relationships,
 * see src/lib/relationshipCanonicalization.ts): "A cites B" and "B cites A"
 * are different facts and usually only one of them is true, so BOTH rows may
 * legitimately coexist and this orientation may never be normalized away.
 *
 * DEFECT THIS FIXES (predates PR8a): the admin creation form
 * (src/app/admin/(protected)/source-items/[id]/page.tsx) bound "this item" to
 * sourceItemIdB and the other item to sourceItemIdA, so every relationship
 * created through the UI was STORED as the inverse of what the admin entered.
 * All three readers -- getSourceItemRelationships, getClaimProvenanceChain,
 * and ProvenanceChain -- were correct, and faithfully displayed the inverted
 * row. The audit summary in createSourceRelationship was self-consistent with
 * the FORM rather than with storage, so the audit trail described the admin's
 * intent while the database held its opposite, which is why the defect never
 * surfaced on inspection. src/db/seed/seed.ts writes A=subject directly,
 * bypassing the form, so all seeded data was always correct.
 *
 * Confirmed blast radius at the time of the fix: ZERO affected rows. Only
 * two source_relationships rows existed, both written by the seed path, both
 * correct, and admin_audit_log held no entity_type = 'source_relationship'
 * entries at all -- proving no row had ever been created through the form.
 * PR8a is therefore code-only: no migration, no data correction.
 *
 * ORIENTATION NOTE for `original`: for the four dependence types (citation,
 * repetition, derivative, aggregation) the subject is the LATER, dependent
 * item. For `original` the subject is the EARLIER, origin item -- "A is the
 * original source for B". The A=subject invariant holds for all seven types;
 * it is the temporal meaning of the subject position that differs between
 * them. Any future graph traversal must special-case this.
 *
 * SCOPE: PR8a exports a SUBJECT-perspective vocabulary only, because that is
 * all any current consumer needs -- the admin relationship list keeps its
 * existing wording and renders the raw enum value on both branches. An
 * object-perspective vocabulary ("is cited by", ...) is deliberately NOT
 * added here: it would have no caller, and this project does not ship
 * premature abstractions. A later PR adds it if and when its UI requires it.
 */

/**
 * Form field names, exported so the admin form binds a named symbol rather
 * than a bare string literal. The literal values must stay exactly these --
 * they are the keys createSourceRelationshipSchema parses.
 */
export const PROVENANCE_SUBJECT_FIELD = "sourceItemIdA" as const;
export const PROVENANCE_OBJECT_FIELD = "sourceItemIdB" as const;

/** Column names, for documentation and for check assertions. */
export const PROVENANCE_SUBJECT_COLUMN = "source_item_id_a" as const;
export const PROVENANCE_OBJECT_COLUMN = "source_item_id_b" as const;

/**
 * Lifted verbatim from ProvenanceChain.tsx's former local `relationshipVerb`
 * map -- PR8a changes no rendered text, it only removes the duplicate so the
 * audit summary and the public provenance chain cannot drift apart.
 */
const SUBJECT_VERB: Record<string, string> = {
  original: "is the original source for",
  independent_corroboration: "independently corroborates",
  citation: "cites",
  repetition: "repeats",
  aggregation: "aggregates",
  derivative: "derives from",
  unknown: "has an unknown relationship to",
};

/**
 * The active-voice verb, read from the SUBJECT (source_item_id_a) side.
 *
 * An unrecognized type falls back to the raw value, preserving the previous
 * defensive behavior: relationshipType is typed `string` at the query layer,
 * not the enum union, so a value outside the known enum must still render
 * something rather than `undefined`.
 */
export function provenanceSubjectVerb(relationshipType: string): string {
  return SUBJECT_VERB[relationshipType] ?? relationshipType;
}

/**
 * Third-person sentence, SUBJECT FIRST. Used by both the admin audit summary
 * (src/db/mutations/provenance.ts) and the public provenance chain
 * (src/components/claim-detail/ProvenanceChain.tsx), so the same stored row
 * produces the same sentence on both surfaces -- asserted directly in
 * src/checks/provenanceDirectionRoundTrip.check.ts.
 */
export function describeProvenanceLink(
  relationshipType: string,
  subjectLabel: string,
  objectLabel: string
): string {
  return `${subjectLabel} ${provenanceSubjectVerb(relationshipType)} ${objectLabel}`;
}
