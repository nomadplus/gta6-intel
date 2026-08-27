import "server-only";
import { adminDb } from "@/db/adminClient";
import {
  getClaimForComparison,
  countComparableClaimsForClaim,
  listComparableClaimsForClaim,
  listComparableClaimsByTrigramSimilarity,
  type ComparableClaim,
} from "@/db/queries/admin";
import { compareClaims, COMPARE_CLAIMS_MAX_CANDIDATES, type CompareClaimsOutput } from "./compareClaims";
import { getAnthropicProvider } from "@/lib/ai/providers/anthropicProvider";
import type { AiProvider } from "@/lib/ai/types";
import type { RunAiOperationResult } from "@/lib/ai/runAiOperation";

/**
 * Phase 5 PR 7 architecture note: this is the ONE place that decides
 * which provider compare_claims actually uses in production, loads the
 * focus claim the operation needs, decides the tiered retrieval
 * strategy, and enforces this operation's eligibility gate. Mirrors
 * detectDuplicatesTrigger.ts's role exactly, with identity narrowed to
 * one EXISTING focus claim instead of one extract_claims candidate.
 *
 * Unlike PR6's detect_duplicates, this operation IS genuinely
 * project-aware: both sides of a comparison are claims rows, and
 * claims.project_id is NOT NULL -- there is no equivalent of PR6's
 * DUPLICATE_CHECK_DEFAULT_PROJECT_ID hardcoded literal here. The
 * shortlist is scoped by the focus claim's OWN project_id, read from the
 * database.
 */

export class ComparisonFocusClaimNotFoundError extends Error {
  constructor(claimId: number) {
    super(`Claim #${claimId} could not be found -- cannot run relationship analysis against a claim that does not exist.`);
    this.name = "ComparisonFocusClaimNotFoundError";
  }
}

// Below this many comparable claims, compare the focus claim against
// every one of them -- no ranking needed. Unlike PR6's detect_duplicates
// (whose output size is independent of its input size), compare_claims'
// output scales WITH the candidate count, so this single constant bounds
// BOTH the AI call's input size and its worst-case output size -- see
// compareClaims.ts's own header comment for why one constant serves both
// roles here where PR6 used two.
export const COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD = 12;

export type TriggerCompareClaimsResult =
  | { kind: "no_comparable_claims" }
  | { kind: "ran"; result: RunAiOperationResult<CompareClaimsOutput> };

/**
 * Loads the shortlist for one focus claim's relationship analysis,
 * applying the tiered strategy: all comparable claims when the project's
 * comparable set is small, a bounded pg_trgm-ranked subset otherwise.
 * Exported separately from triggerCompareClaims so it can be
 * unit-checked against a real database without needing a provider at
 * all (see compareClaimsOrchestration.check.ts).
 *
 * KNOWN, DOCUMENTED LIMITATION: above the threshold, ranking is purely
 * LEXICAL (pg_trgm), not semantic. A genuine "contradicts" pair, or a
 * "subsumes"/"refines" pair phrased at very different levels of
 * abstraction, need not share vocabulary at all -- such a pair can fail
 * to be shortlisted once a project exceeds this threshold, even though
 * the relationship genuinely exists. This produces false negatives
 * (relationships never surfaced), never false positives -- every
 * surfaced recommendation still requires human approval before it can
 * affect the claim graph. This is an accepted limitation for PR7, not
 * something to solve with embeddings here: `ai_operation` already
 * carries an unused `embed` value, and semantic retrieval belongs to the
 * future Autonomous Web Discovery phase, when claim volume makes it
 * necessary and provides real data to tune it against. Do not read a
 * small `assessments` array as proof a claim has no relationships.
 *
 * `focusStatement` is passed in explicitly (rather than re-fetched here)
 * so this function needs only a single already-resolved focus claim,
 * never a second lookup -- triggerCompareClaims below is the only
 * production/admin call site, and it has already resolved the focus
 * claim by the time it calls this function.
 */
export async function getComparisonShortlist(
  claimId: number,
  projectId: number,
  focusStatement: string
): Promise<ComparableClaim[]> {
  const total = await countComparableClaimsForClaim(adminDb, claimId, projectId);
  if (total === 0) return [];
  if (total <= COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD) return listComparableClaimsForClaim(adminDb, claimId, projectId);
  return listComparableClaimsByTrigramSimilarity(adminDb, claimId, projectId, focusStatement, COMPARE_CLAIMS_MAX_CANDIDATES);
}

export async function triggerCompareClaims(
  claimId: number,
  provider: AiProvider = getAnthropicProvider()
): Promise<TriggerCompareClaimsResult> {
  const focusClaim = await getClaimForComparison(adminDb, claimId);
  if (!focusClaim) throw new ComparisonFocusClaimNotFoundError(claimId);

  const shortlist = await getComparisonShortlist(claimId, focusClaim.projectId, focusClaim.statement);

  // Zero comparable claims: do not spend an Anthropic call merely to
  // discover that nothing exists to compare against -- this is a
  // deterministic pre-condition short-circuit at the trigger level,
  // exactly like detectDuplicatesTrigger.ts's own no_existing_claims
  // short-circuit. No ai_jobs row is created; the caller (the admin
  // action layer) renders this as the distinct no_comparable_claims
  // state, not as an "analysed, found nothing" success -- an analysis
  // never actually ran.
  if (shortlist.length === 0) {
    return { kind: "no_comparable_claims" };
  }

  const result = await compareClaims({
    provider,
    focusClaim: { id: focusClaim.id, statement: focusClaim.statement },
    candidateClaims: shortlist,
  });

  return { kind: "ran", result };
}
