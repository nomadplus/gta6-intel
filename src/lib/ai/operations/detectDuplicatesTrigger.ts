import "server-only";
import { adminDb } from "@/db/adminClient";
import { getExtractionCandidate } from "@/db/mutations/claimProposalReviews";
import { isProposalReviewed, countClaimsForProject, listClaimsForProject, listClaimsByTrigramSimilarity } from "@/db/queries/admin";
import { detectDuplicates, type DetectDuplicatesOutput, type DuplicateCandidateClaimForCheck } from "./detectDuplicates";
import { getAnthropicProvider } from "@/lib/ai/providers/anthropicProvider";
import type { AiProvider } from "@/lib/ai/types";
import type { RunAiOperationResult } from "@/lib/ai/runAiOperation";

/**
 * Phase 5 PR 6 architecture note: this is the ONE place that decides
 * which provider detect_duplicates actually uses in production, loads
 * the candidate the operation needs, decides the tiered retrieval
 * strategy, and enforces this operation's eligibility gate. Mirrors
 * extractClaimsTrigger.ts's role exactly, plus a SECOND eligibility
 * check extractClaims never needed: a candidate that has already been
 * reviewed (approved, rejected, or resolved to an existing claim) is not
 * eligible for a NEW duplicate check -- see
 * ProposalAlreadyReviewedForDuplicateCheckError below.
 */

export class DuplicateCheckCandidateNotFoundError extends Error {
  constructor(aiResultId: number, candidateIndex: number) {
    super(
      `Extraction candidate ${candidateIndex} of AI result #${aiResultId} could not be resolved -- ` +
        `cannot run duplicate detection against a candidate that does not exist or was not produced by a successful extraction.`
    );
    this.name = "DuplicateCheckCandidateNotFoundError";
  }
}

/**
 * Thrown when this exact candidate has already been reviewed (approve,
 * reject, or link_existing_claim) -- checked BEFORE any retrieval work,
 * before any ai_jobs row is created, and before any provider call, so a
 * reviewed proposal produces zero new job rows and zero AI spend. A job
 * that was already pending/running at the moment a candidate became
 * reviewed is left completely alone by this check -- it is never
 * cancelled, and its eventual result remains valid historical advisory
 * data; this error only ever blocks a NEW attempt (a fresh check, a
 * retry, or a recovery-then-retry), never an already in-flight one.
 *
 * Also thrown by detectDuplicatesRecovery.ts's reclaim mutation, using
 * the same isProposalReviewed fact -- imported from this orchestration
 * module rather than duplicated, since both call sites are orchestration/
 * mutation layers translating the SAME neutral query-layer fact into
 * their own domain error, per this project's "queries return facts,
 * callers own errors" convention.
 */
export class ProposalAlreadyReviewedForDuplicateCheckError extends Error {
  constructor(aiResultId: number, candidateIndex: number) {
    super(
      `Extraction candidate ${candidateIndex} of AI result #${aiResultId} has already been reviewed -- ` +
        `duplicate detection is not available for a reviewed proposal.`
    );
    this.name = "ProposalAlreadyReviewedForDuplicateCheckError";
  }
}

// Below this many existing claims, compare the candidate against every
// one of them -- no ranking needed. Even MAX_ALL_CLAIMS_THRESHOLD full
// claim statements (statement is capped at 2000 chars, but realistic
// GTA VI claims are far shorter) is a trivial, cheap payload; there is
// no cost pressure to rank at this scale.
export const DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD = 30;

// Above the threshold, rank by pg_trgm lexical similarity and take only
// this many -- keeps the AI call's input size (and therefore its cost)
// flat regardless of whether the claims table has 100 or 10,000 rows.
// 20 is generous enough to surface a genuine near-duplicate that isn't
// the single closest lexical match, while still being an order of
// magnitude smaller than a table that has grown past the all-claims
// threshold.
export const DUPLICATE_CHECK_PREFILTER_LIMIT = 20;

/**
 * IMPORTANT, explicitly-flagged limitation: source_items/sources carry NO
 * project_id in this schema -- only claims.projectId does, and that value
 * is chosen by a human at APPROVAL time (see approveClaimProposal's
 * data.projectId), not derivable from a source item or an unreviewed
 * extraction candidate. Investigation confirmed this is genuinely
 * unresolvable within PR6's scope without a real schema/UI change (adding
 * a project-selection step to the duplicate-check trigger itself, or
 * linking source items to a project) -- both of which would expand this
 * PR's approved scope and were explicitly out of bounds for this pass.
 *
 * There is also no ENFORCED single-project invariant anywhere in this
 * codebase (no CHECK constraint on `projects`, no application-level guard
 * against inserting a second row) -- multiple projects are structurally
 * supported by the schema (claims.projectId, topics.projectId, and their
 * per-project unique indexes). But every single existing admin write path
 * that creates a claim already makes the SAME simplifying assumption PR6
 * makes here: src/app/admin/(protected)/claims/new/page.tsx,
 * src/app/admin/(protected)/review/page.tsx's approve form, and
 * src/app/admin/(protected)/topics/page.tsx ALL hardcode the identical
 * literal projectId "1", with no project-selector UI anywhere in this
 * application. Retrieval unscoped by project would have made PR6 the
 * only place in the codebase behaving inconsistently with every sibling
 * admin mutation -- not a neutral simplification, an actual
 * inconsistency. This constant makes PR6 consistent with that existing
 * convention instead of inventing a different one; if a genuine
 * multi-project UI is ever built, this -- and the three hardcoded "1"
 * literals above -- all need to be replaced together with a real
 * project-selection mechanism, not just this one.
 */
export const DUPLICATE_CHECK_DEFAULT_PROJECT_ID = 1;

export type TriggerDetectDuplicatesResult =
  | { kind: "no_existing_claims" }
  | { kind: "ran"; result: RunAiOperationResult<DetectDuplicatesOutput> };

/**
 * Loads the retrieval set for one candidate's duplicate check, applying
 * the tiered strategy: all claims when the table is small, a bounded
 * pg_trgm-ranked subset otherwise. Exported separately from
 * triggerDetectDuplicates so it can be unit-checked against a real
 * database without needing a provider at all (see
 * detectDuplicatesOrchestration.check.ts).
 *
 * `projectId` is an injectable dependency, defaulting to
 * DUPLICATE_CHECK_DEFAULT_PROJECT_ID -- production/admin code paths
 * never pass this argument explicitly (see triggerDetectDuplicates'
 * matching default below and runDetectDuplicatesAction in
 * review/actions.ts, which calls triggerDetectDuplicates with no project
 * argument at all), so real traffic always resolves to the same
 * server-side default. This parameter exists ONLY so a check can prove
 * the zero-existing-claims short-circuit deterministically, against a
 * genuinely empty, isolated project, without being at the mercy of
 * whatever claims a shared seeded database happens to already contain
 * for project 1 -- never accept this value from a browser/form input.
 */
export async function getDuplicateCheckRetrievalSet(
  candidateStatement: string,
  projectId: number = DUPLICATE_CHECK_DEFAULT_PROJECT_ID
): Promise<DuplicateCandidateClaimForCheck[]> {
  const total = await countClaimsForProject(adminDb, projectId);
  if (total === 0) return [];
  if (total <= DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD) return listClaimsForProject(adminDb, projectId);
  return listClaimsByTrigramSimilarity(adminDb, projectId, candidateStatement, DUPLICATE_CHECK_PREFILTER_LIMIT);
}

/**
 * `projectId` is the same injectable-for-testing dependency described on
 * getDuplicateCheckRetrievalSet above, with the identical default and the
 * identical rule: no production or admin-action call site ever passes it
 * explicitly, and nothing derives it from a browser-submitted value.
 */
export async function triggerDetectDuplicates(
  aiResultId: number,
  candidateIndex: number,
  provider: AiProvider = getAnthropicProvider(),
  projectId: number = DUPLICATE_CHECK_DEFAULT_PROJECT_ID
): Promise<TriggerDetectDuplicatesResult> {
  const candidate = await getExtractionCandidate(adminDb, aiResultId, candidateIndex);
  if (!candidate) throw new DuplicateCheckCandidateNotFoundError(aiResultId, candidateIndex);

  if (await isProposalReviewed(adminDb, aiResultId, candidateIndex)) {
    throw new ProposalAlreadyReviewedForDuplicateCheckError(aiResultId, candidateIndex);
  }

  const existingClaims = await getDuplicateCheckRetrievalSet(candidate.candidate.statement, projectId);

  // Zero existing claims: do not spend an Anthropic call merely to
  // discover that no duplicate exists -- this is a deterministic
  // pre-condition short-circuit at the trigger level, exactly like
  // extractClaimsTrigger.ts's eligibility check throwing BEFORE calling
  // extractClaims()/runAiOperation() for an ineligible source item. No
  // ai_jobs row is created; the caller (the admin action layer) renders
  // this as the distinct no_existing_claims state, not as a "checked,
  // found nothing" success -- a check never actually ran.
  if (existingClaims.length === 0) {
    return { kind: "no_existing_claims" };
  }

  const result = await detectDuplicates({
    provider,
    sourceItemId: candidate.sourceItemId,
    extractionAiResultId: candidate.aiResultId,
    extractionCandidateIndex: candidate.candidateIndex,
    candidateStatement: candidate.candidate.statement,
    existingClaims,
  });

  return { kind: "ran", result };
}
