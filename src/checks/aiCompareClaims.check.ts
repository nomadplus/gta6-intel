/**
 * Regression check for Phase 5 PR 7's compareClaims operation output
 * schema (src/lib/ai/operations/compareClaims.ts). Pure -- no database,
 * no network, exercises buildCompareClaimsOutputSchema() directly.
 *
 * Covers:
 *   - fabricated otherClaimId (not one of the ids supplied to this call) rejected
 *   - self-reference (otherClaimId === focus claim's own id) rejected
 *   - direction required for subsumes/refines
 *   - direction forbidden for equivalent/related/contradicts
 *   - duplicate otherClaimId within one result rejected
 *   - noRelationshipNote rejected alongside a non-empty assessments array
 *   - > MAX_COMPARE_CLAIMS_ASSESSMENTS assessments rejected
 *   - reasoning length bounds
 *   - the schema's directional set IS DIRECTIONAL_RELATIONSHIP_TYPES
 *     imported from relationshipCanonicalization.ts (same object), so
 *     this schema and the eventual claim_relationships write can never
 *     silently disagree about which types are directional
 *
 * Run with: npx tsx src/checks/aiCompareClaims.check.ts
 */
import { buildCompareClaimsOutputSchema, MAX_COMPARE_CLAIMS_ASSESSMENTS } from "../lib/ai/operations/compareClaims";
import { DIRECTIONAL_RELATIONSHIP_TYPES } from "../lib/relationshipCanonicalization";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== compare_claims output schema (Phase 5 PR 7) -- pure, no DB ===\n");

const FOCUS = { id: 1, statement: "The game is set in a Miami-inspired city." };
const CANDIDATES = [
  { id: 2, statement: "The fictional city is called Vice City." },
  { id: 3, statement: "There is a swamp biome on the map." },
];
const schema = buildCompareClaimsOutputSchema(FOCUS, CANDIDATES);

function validAssessment(overrides: Record<string, unknown> = {}) {
  return {
    otherClaimId: 2,
    relationshipType: "related",
    confidence: 0.8,
    reasoning: "A generic connection.",
    ...overrides,
  };
}

// --- fabricated otherClaimId ------------------------------------------------
{
  const result = schema.safeParse({ assessments: [validAssessment({ otherClaimId: 999 })] });
  assert(!result.success, "a fabricated otherClaimId (not in the supplied candidate set) is rejected");
}

// --- self-reference ----------------------------------------------------------
{
  const result = schema.safeParse({ assessments: [validAssessment({ otherClaimId: FOCUS.id })] });
  assert(!result.success, "otherClaimId equal to the focus claim's own id is rejected");
}

// --- direction required for directional types -------------------------------
{
  const missingDirection = schema.safeParse({ assessments: [validAssessment({ relationshipType: "refines" })] });
  assert(!missingDirection.success, "relationshipType 'refines' with no direction is rejected");

  const missingDirectionSubsumes = schema.safeParse({ assessments: [validAssessment({ relationshipType: "subsumes" })] });
  assert(!missingDirectionSubsumes.success, "relationshipType 'subsumes' with no direction is rejected");

  const withDirection = schema.safeParse({ assessments: [validAssessment({ relationshipType: "refines", direction: "focus_to_other" })] });
  assert(withDirection.success, "relationshipType 'refines' WITH a direction is accepted");

  const withOtherDirection = schema.safeParse({ assessments: [validAssessment({ relationshipType: "subsumes", direction: "other_to_focus" })] });
  assert(withOtherDirection.success, "relationshipType 'subsumes' with the other direction value is also accepted");
}

// --- direction forbidden for symmetric types --------------------------------
for (const symmetricType of ["equivalent", "related", "contradicts"]) {
  const result = schema.safeParse({ assessments: [validAssessment({ relationshipType: symmetricType, direction: "focus_to_other" })] });
  assert(!result.success, `relationshipType '${symmetricType}' WITH a direction present is rejected (symmetric types have no direction)`);

  const okResult = schema.safeParse({ assessments: [validAssessment({ relationshipType: symmetricType })] });
  assert(okResult.success, `relationshipType '${symmetricType}' with no direction is accepted`);
}

// --- duplicate otherClaimId --------------------------------------------------
{
  const result = schema.safeParse({
    assessments: [validAssessment({ otherClaimId: 2, relationshipType: "related" }), validAssessment({ otherClaimId: 2, relationshipType: "equivalent" })],
  });
  assert(!result.success, "two assessments naming the SAME otherClaimId within one result are rejected");
}

// --- noRelationshipNote only valid alongside an EMPTY assessments array -----
{
  const emptyWithNote = schema.safeParse({ assessments: [], noRelationshipNote: "Nothing meaningful found." });
  assert(emptyWithNote.success, "an empty assessments array WITH a noRelationshipNote is accepted");

  const nonEmptyWithNote = schema.safeParse({ assessments: [validAssessment()], noRelationshipNote: "Should not be allowed here." });
  assert(!nonEmptyWithNote.success, "a noRelationshipNote alongside a NON-empty assessments array is rejected");

  const emptyNoNote = schema.safeParse({ assessments: [] });
  assert(emptyNoNote.success, "an empty assessments array with NO note is also accepted (the note is optional)");
}

// --- max assessments ceiling --------------------------------------------------
{
  const manyCandidates = Array.from({ length: MAX_COMPARE_CLAIMS_ASSESSMENTS + 1 }, (_, i) => ({ id: 100 + i, statement: `Candidate ${i}` }));
  const bigSchema = buildCompareClaimsOutputSchema(FOCUS, manyCandidates);
  const tooMany = bigSchema.safeParse({
    assessments: manyCandidates.map((c) => validAssessment({ otherClaimId: c.id, relationshipType: "related" })),
  });
  assert(!tooMany.success, `more than MAX_COMPARE_CLAIMS_ASSESSMENTS (${MAX_COMPARE_CLAIMS_ASSESSMENTS}) assessments is rejected`);

  const atLimit = manyCandidates.slice(0, MAX_COMPARE_CLAIMS_ASSESSMENTS).map((c) => validAssessment({ otherClaimId: c.id, relationshipType: "related" }));
  const exactlyAtLimit = bigSchema.safeParse({ assessments: atLimit });
  assert(exactlyAtLimit.success, `exactly MAX_COMPARE_CLAIMS_ASSESSMENTS (${MAX_COMPARE_CLAIMS_ASSESSMENTS}) assessments is accepted`);
}

// --- reasoning length bounds --------------------------------------------------
{
  const empty = schema.safeParse({ assessments: [validAssessment({ reasoning: "" })] });
  assert(!empty.success, "empty reasoning is rejected");

  const tooLong = schema.safeParse({ assessments: [validAssessment({ reasoning: "x".repeat(241) })] });
  assert(!tooLong.success, "reasoning over 240 characters is rejected");

  const atLimit = schema.safeParse({ assessments: [validAssessment({ reasoning: "x".repeat(240) })] });
  assert(atLimit.success, "reasoning at exactly 240 characters is accepted");
}

// --- confidence bounds --------------------------------------------------------
{
  const tooHigh = schema.safeParse({ assessments: [validAssessment({ confidence: 1.5 })] });
  assert(!tooHigh.success, "confidence above 1 is rejected");
  const tooLow = schema.safeParse({ assessments: [validAssessment({ confidence: -0.1 })] });
  assert(!tooLow.success, "confidence below 0 is rejected");
}

// --- schema/write-path directional-set agreement ------------------------------
{
  assert(
    DIRECTIONAL_RELATIONSHIP_TYPES.has("subsumes") && DIRECTIONAL_RELATIONSHIP_TYPES.has("refines"),
    "DIRECTIONAL_RELATIONSHIP_TYPES (imported directly by compareClaims.ts's schema) contains exactly subsumes/refines"
  );
  assert(
    !DIRECTIONAL_RELATIONSHIP_TYPES.has("equivalent") &&
      !DIRECTIONAL_RELATIONSHIP_TYPES.has("related") &&
      !DIRECTIONAL_RELATIONSHIP_TYPES.has("contradicts"),
    "DIRECTIONAL_RELATIONSHIP_TYPES does not contain any of the three symmetric types"
  );
}

console.log(failures === 0 ? "\nAll compare_claims schema checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
