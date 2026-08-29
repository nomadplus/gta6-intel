import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { adminDb } from "@/db/adminClient";
import { discoveryCandidates, discoveryCandidateObservations, ingestionJobs, sourceItems } from "@/db/schema";
import { normalizeUrl } from "@/lib/ingestion/urlNormalization";
import type { DbTransaction } from "./shared";
import type { DiscoverySighting, RecordSightingResult, PromotedCandidate } from "@/lib/discovery/types";

/**
 * Phase 6 PR 6.1: the I/O layer for the discovery candidate ledger
 * (discoveryCandidates / discoveryCandidateObservations, migration 0028).
 * No requireAdmin()/audit-log call here -- same boundary-auditability
 * rationale as discoveryPolling.ts and aiJobs.ts's own file headers: these
 * writes are automated pipeline bookkeeping, not a live admin request.
 *
 * Nothing in this file is called by any route or cron yet. Both
 * recordDiscoverySighting() and claimEligibleCandidatesForPromotion() are
 * written and fully tested now (per the approved plan), dormant until a
 * later PR wires a real discovery provider and a promotion caller in.
 */

// ---------------------------------------------------------------------------
// Write side: recording one provider/feed sighting
// ---------------------------------------------------------------------------

/**
 * Records one discovery sighting:
 *   1. Normalizes the sighting's URL. A malformed/unsupported URL creates
 *      NO candidate and NO observation (per the locked spec) -- this is
 *      an ordinary, expected outcome for autonomous provider output, not
 *      an exceptional program error, so it is returned as a typed result
 *      rather than thrown (contrast with prepareIngestionSubmission's
 *      throw, which is for a human-typed form submission).
 *   2. Upserts the candidate by normalizedUrl -- ON CONFLICT DO UPDATE
 *      advances last_seen_at (GREATEST, forward-only) on every valid
 *      sighting including a replay; first_seen_at/admissibility are never
 *      touched here. A genuinely new candidate is forced to
 *      admissibility = 'excluded' by the database trigger regardless of
 *      what this function inserts (it never attempts to set
 *      admissibility on the candidate at all).
 *   3. Inserts the observation. When discoveryFeedId is present, ON
 *      CONFLICT against the partial replay-identity index advances only
 *      last_seen_at (never admissibility or any identity field) -- a
 *      repeated feed sighting is idempotent. Without a discoveryFeedId, no
 *      conflict target exists and a fresh row is always inserted
 *      (deliberately not generalized -- see migration 0028's header).
 *
 * The parent candidate's admissibility raise happens ENTIRELY via the
 * database's AFTER INSERT trigger on discovery_candidate_observations --
 * this function never computes or writes admissibility on the candidate
 * itself, on either the insert or the replay path.
 *
 * Deliberately returns only what a caller actually needs (candidate/
 * observation identity, or an invalid-URL reason) -- per the approved
 * correction, no "recorded" vs "replayed" distinction is manufactured via
 * xmax, system columns, timestamp-equality tricks, or a race-prone
 * pre-SELECT, since no production caller in this PR needs that
 * distinction.
 */
export async function recordDiscoverySighting(sighting: DiscoverySighting): Promise<RecordSightingResult> {
  const normalized = normalizeUrl(sighting.rawUrl);
  if (!normalized.ok) {
    return { outcome: "invalid_url", reason: normalized.error.message };
  }
  const normalizedUrl = normalized.normalizedUrl;

  return adminDb.transaction(async (tx) => {
    const [candidate] = await tx
      .insert(discoveryCandidates)
      .values({ normalizedUrl })
      .onConflictDoUpdate({
        target: discoveryCandidates.normalizedUrl,
        set: {
          lastSeenAt: sql`GREATEST(${discoveryCandidates.lastSeenAt}, excluded.last_seen_at)`,
        },
      })
      .returning({ id: discoveryCandidates.id });

    const observationValues = {
      discoveryCandidateId: candidate!.id,
      discoveryProviderId: sighting.discoveryProviderId,
      discoveryFeedId: sighting.discoveryFeedId ?? null,
      observedUrl: sighting.rawUrl,
      admissibility: sighting.admissibility,
    };

    const [observation] = sighting.discoveryFeedId
      ? await tx
          .insert(discoveryCandidateObservations)
          .values(observationValues)
          .onConflictDoUpdate({
            target: [
              discoveryCandidateObservations.discoveryFeedId,
              discoveryCandidateObservations.discoveryCandidateId,
            ],
            targetWhere: sql`${discoveryCandidateObservations.discoveryFeedId} IS NOT NULL`,
            set: {
              lastSeenAt: sql`GREATEST(${discoveryCandidateObservations.lastSeenAt}, excluded.last_seen_at)`,
            },
          })
          .returning({ id: discoveryCandidateObservations.id })
      : await tx.insert(discoveryCandidateObservations).values(observationValues).returning({
          id: discoveryCandidateObservations.id,
        });

    return { outcome: "recorded", candidateId: candidate!.id, observationId: observation!.id };
  });
}

// ---------------------------------------------------------------------------
// Promotion side: claiming eligible candidates and creating ingestion_jobs
// ---------------------------------------------------------------------------

const DEFAULT_PROMOTION_BATCH_SIZE = 10;

/**
 * Selects up to `batchSize` eligible, not-yet-claimed candidates, oldest
 * first, using FOR UPDATE SKIP LOCKED -- the same batch-worker locking
 * primitive as claimDueDiscoveryFeeds. Must run inside the SAME
 * transaction as the subsequent ingestion_jobs insert (see
 * claimEligibleCandidatesForPromotion below) -- exposing this as a
 * standalone, separately-committed step would let a claimed row's lock
 * release before a job is actually created for it, defeating the point
 * of the lock entirely.
 *
 * The exclusion conditions here are the PRIMARY defense against
 * repeatedly reclaiming a candidate whose normalized URL already exists
 * historically in ingestion_jobs (any status, any provider) or
 * source_items -- not merely a later per-row recheck.
 */
async function selectClaimableCandidates(
  tx: DbTransaction,
  batchSize: number
): Promise<Array<{ id: number; normalizedUrl: string }>> {
  return tx
    .select({ id: discoveryCandidates.id, normalizedUrl: discoveryCandidates.normalizedUrl })
    .from(discoveryCandidates)
    .where(
      and(
        eq(discoveryCandidates.admissibility, "eligible"),
        sql`NOT EXISTS (SELECT 1 FROM ${ingestionJobs} WHERE ${ingestionJobs.discoveryCandidateId} = ${discoveryCandidates.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${ingestionJobs} WHERE ${ingestionJobs.normalizedUrl} = ${discoveryCandidates.normalizedUrl})`,
        sql`NOT EXISTS (SELECT 1 FROM ${sourceItems} WHERE ${sourceItems.normalizedUrl} = ${discoveryCandidates.normalizedUrl})`
      )
    )
    .orderBy(asc(discoveryCandidates.firstSeenAt), asc(discoveryCandidates.id))
    .limit(batchSize)
    .for("update", { of: discoveryCandidates, skipLocked: true });
}

/**
 * Re-runs the SAME existing-URL exclusion immediately before INSERT, for
 * one already-claimed candidate -- defense-in-depth against a race the
 * claim SELECT's own snapshot can't fully close (see the approved
 * correction). Under FOR UPDATE SKIP LOCKED this row is already locked by
 * this transaction, so this recheck is normally redundant with the claim
 * query itself; it exists for correctness under concurrent scenarios this
 * function's author cannot fully enumerate, not because it is expected to
 * ever actually reject anything in ordinary operation.
 */
async function normalizedUrlAlreadyExists(tx: DbTransaction, normalizedUrl: string): Promise<boolean> {
  const [existingJob] = await tx
    .select({ id: ingestionJobs.id })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.normalizedUrl, normalizedUrl))
    .limit(1);
  if (existingJob) return true;

  const [existingItem] = await tx
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(eq(sourceItems.normalizedUrl, normalizedUrl))
    .limit(1);
  return Boolean(existingItem);
}

/**
 * The deterministic promotion origin for one candidate: the earliest
 * (first_seen_at ASC, id ASC) observation currently at admissibility =
 * 'eligible'. The created ingestion_job copies its discoveryProviderId/
 * discoveryFeedId/observedUrl from this exact observation -- observedUrl
 * is what actually gets submitted (see claimEligibleCandidatesForPromotion's
 * own comment on why submittedUrl must be the origin's raw observed URL,
 * not the candidate's already-normalized identity).
 */
async function selectPromotionOrigin(
  tx: DbTransaction,
  candidateId: number
): Promise<
  { id: number; discoveryProviderId: number; discoveryFeedId: number | null; observedUrl: string } | undefined
> {
  const [origin] = await tx
    .select({
      id: discoveryCandidateObservations.id,
      discoveryProviderId: discoveryCandidateObservations.discoveryProviderId,
      discoveryFeedId: discoveryCandidateObservations.discoveryFeedId,
      observedUrl: discoveryCandidateObservations.observedUrl,
    })
    .from(discoveryCandidateObservations)
    .where(
      and(
        eq(discoveryCandidateObservations.discoveryCandidateId, candidateId),
        eq(discoveryCandidateObservations.admissibility, "eligible")
      )
    )
    .orderBy(asc(discoveryCandidateObservations.firstSeenAt), asc(discoveryCandidateObservations.id))
    .limit(1);
  return origin;
}

/**
 * Claims up to `batchSize` eligible discovery candidates and creates one
 * ingestion_jobs row for each, ALL within a single transaction (per the
 * approved correction -- claiming and insertion are never split across
 * transactions, which would let a claimed row's lock release before a job
 * actually exists for it).
 *
 * For each claimed candidate, in order:
 *   1. Re-check the existing-URL exclusion (defense-in-depth; see
 *      normalizedUrlAlreadyExists's own comment) -- a candidate that now
 *      fails this recheck is skipped, not treated as an error.
 *   2. Select the deterministic origin observation. Absence here would
 *      mean the claim query's own `admissibility = 'eligible'` condition
 *      and this observation-level lookup have drifted apart -- treated as
 *      a data-integrity error, not a normal skip.
 *   3. Insert the ingestion_jobs row. submittedUrl is the origin
 *      observation's own observedUrl -- the exact raw URL that
 *      provider/feed sighting actually reported, preserved for audit, the
 *      same submitted/normalized distinction every other ingestion_jobs
 *      row already carries -- NOT the candidate's normalizedUrl (which is
 *      reserved for the normalizedUrl column). discoveryProviderId/
 *      discoveryFeedId are copied from that same origin.
 *
 *      Uses `ON CONFLICT DO NOTHING` (no explicit target -- this
 *      deliberately covers ANY unique-constraint conflict on the table,
 *      both ingestion_jobs_discovery_candidate_id_unique (another path
 *      already promoted this exact candidate) and the pre-existing
 *      ingestion_jobs_discovery_feed_normalized_url_unique dedupe index
 *      (this normalizedUrl was concurrently claimed by the RSS poller
 *      instead)), NOT a caught 23505. A raised unique-constraint error
 *      would abort the whole surrounding transaction until rollback --
 *      catching the resulting JS exception does not undo that, so a
 *      caught-exception approach here would silently corrupt every other
 *      candidate already promoted earlier in this same loop. `RETURNING`
 *      is absent for a conflicting row (no error, no row) -- absence of a
 *      returned row is exactly what "already handled by a racing
 *      insert" means here, treated as a normal skip.
 *
 * No requireAdmin() -- this is system-initiated (initiatedBy: "system"),
 * matching createSystemDiscoveredJob's own convention.
 */
export async function claimEligibleCandidatesForPromotion(
  batchSize: number = DEFAULT_PROMOTION_BATCH_SIZE
): Promise<PromotedCandidate[]> {
  return adminDb.transaction(async (tx) => {
    const claimed = await selectClaimableCandidates(tx, batchSize);
    const promoted: PromotedCandidate[] = [];

    for (const candidate of claimed) {
      if (await normalizedUrlAlreadyExists(tx, candidate.normalizedUrl)) {
        continue;
      }

      const origin = await selectPromotionOrigin(tx, candidate.id);
      if (!origin) {
        throw new Error(
          `discovery_candidates.id=${candidate.id} is 'eligible' but has no eligible observation -- data integrity error.`
        );
      }

      const [job] = await tx
        .insert(ingestionJobs)
        .values({
          submittedUrl: origin.observedUrl,
          normalizedUrl: candidate.normalizedUrl,
          discoveryProviderId: origin.discoveryProviderId,
          discoveryFeedId: origin.discoveryFeedId,
          discoveryCandidateId: candidate.id,
          discoveryCandidateObservationId: origin.id,
          initiatedBy: "system",
          adminUserId: null,
          status: "queued",
        })
        .onConflictDoNothing()
        .returning({ id: ingestionJobs.id });

      if (!job) {
        // Already promoted (or its normalizedUrl already claimed by a
        // racing feed-discovered job) via another path -- see this
        // function's own comment above. Not expected under normal SKIP
        // LOCKED operation, but handled without ever raising a
        // constraint violation inside this transaction.
        continue;
      }

      promoted.push({
        candidateId: candidate.id,
        observationId: origin.id,
        ingestionJobId: job.id,
        normalizedUrl: candidate.normalizedUrl,
      });
    }

    return promoted;
  });
}
