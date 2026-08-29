/**
 * DB-backed regression check for Phase 6 PR 6.1's discovery candidate
 * ledger (src/db/mutations/discoveryCandidates.ts, migration 0028).
 *
 * Exercises the REAL mutation functions (recordDiscoverySighting,
 * claimEligibleCandidatesForPromotion), not a reimplementation of their
 * logic -- same convention as sourceItemLinks.check.ts. Both are
 * "server-only"-guarded, so this must run with --conditions=react-server.
 *
 * Proves, against a real local PostgreSQL database (never Supabase
 * staging/production):
 *   - a candidate is forced to admissibility='excluded' at insert time by
 *     the database trigger, regardless of what is supplied
 *   - held/eligible observations raise the parent candidate correctly,
 *     and admissibility is never lowered once raised
 *   - a direct UPDATE attempting to lower admissibility is rejected
 *   - a direct UPDATE attempting to RAISE admissibility with no
 *     justifying observation on record is ALSO rejected -- the fold must
 *     be earned by an actual observation of at least that rank, not
 *     merely be non-decreasing; the legitimate observation-trigger raise
 *     path continues to succeed
 *   - a direct UPDATE attempting to move last_seen_at backwards is
 *     rejected, on both discovery_candidates and
 *     discovery_candidate_observations
 *   - a feed replay advances BOTH the observation's and the candidate's
 *     last_seen_at, and resolves to the SAME observation row (no second
 *     row created)
 *   - two different feeds observing the same normalized URL produce ONE
 *     candidate and TWO observations
 *   - the composite candidate/observation FK rejects a mismatched pair
 *   - both-null discovery fields remain valid for a legacy/manual
 *     ingestion_jobs insert; a half-populated pair is rejected by the
 *     pairing CHECK (this also confirms the pairing CHECK is doing real
 *     work: a multi-column FK alone uses MATCH SIMPLE semantics and does
 *     NOT enforce anything when only one of its columns is NULL -- see
 *     the deviation note in the implementation report)
 *   - promotion origin selection is deterministic (earliest first_seen_at
 *     among a candidate's eligible observations, even when a later
 *     observation is also eligible)
 *   - the created ingestion_jobs row's submitted_url is the origin
 *     observation's own raw observedUrl -- distinct from and never equal
 *     to normalized_url when the two actually differ
 *   - one candidate cannot produce two ingestion_jobs rows
 *   - two concurrent promotion attempts never duplicate work -- proven
 *     two ways: (a) a manually-held row lock deterministically causes
 *     claimEligibleCandidatesForPromotion to skip that candidate via
 *     SKIP LOCKED, then successfully claim it once the lock releases,
 *     and (b) two genuinely concurrent calls to the real function never
 *     promote the same candidate twice
 *   - a candidate whose normalized URL already exists in ingestion_jobs
 *     (any status/provider) is never promoted
 *   - a candidate whose normalized URL already exists in source_items is
 *     never promoted
 *   - admin_role can directly INSERT into both new tables and their id
 *     sequences advance (proves migration 0028's sequence USAGE grants,
 *     independent of any application code)
 *   - discovery_admissibility_rank() fails closed (raises, never returns
 *     NULL) for every value pg_enum currently reports for
 *     discovery_admissibility, read live rather than hardcoded
 *
 * Cleanup note: discovery_candidates/discovery_candidate_observations
 * rows can never be deleted (migration 0028's own triggers) and this
 * check does not attempt to -- that part of the ledger's append-only
 * design is unaffected. What this check DOES clean up, in a top-level
 * finally block so it runs even if an assertion fails: every
 * ingestion_jobs row it created (directly, or via
 * claimEligibleCandidatesForPromotion -- tracked through the
 * promoteAndTrack() wrapper below) is transitioned to the real
 * 'blocked_by_policy' terminal status via the actual
 * completeWithFailure() patch builder (never claimable again by
 * claimEligibleIngestionJobsForProcessing, regardless of status/
 * nextRetryAt), and both synthetic discovery_feeds rows this check
 * creates are disabled (enabled=false, never due for polling). This is
 * what makes this check, and check:ingestion-processor after it,
 * rerunnable against the same database without a reset -- a 'queued'
 * job left behind by an earlier run of this check was previously
 * claimable by an unrelated later check's own eligible-job query,
 * corrupting its exact-count/ordering assertions. Every fixture URL/feed
 * still uses a randomUUID() suffix so repeated runs never collide on
 * identity either.
 *
 * Run with: npx tsx --conditions=react-server src/checks/discoveryCandidateLedger.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, Client } from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import {
  discoveryCandidates,
  discoveryCandidateObservations,
  ingestionJobs,
  sourceItems,
  discoveryFeeds,
} from "../db/schema";
import { adminDb } from "../db/adminClient";
import { recordDiscoverySighting, claimEligibleCandidatesForPromotion } from "../db/mutations/discoveryCandidates";
import { fakeSighting, MANUAL_PROVIDER_ID, RSS_PROVIDER_ID } from "./helpers/fakeDiscoveryProvider";
import { normalizeUrl } from "../lib/ingestion/urlNormalization";
import { completeWithFailure } from "../lib/ingestion/ingestionJobLifecycle";
import type { PromotedCandidate } from "../lib/discovery/types";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function assertThrows(fn: () => Promise<unknown>, message: string) {
  try {
    await fn();
    console.error(`FAIL: ${message} (did not throw)`);
    failures++;
  } catch {
    console.log(`PASS: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Seeded reference data (src/db/seed/seed.ts) -- same convention as
// sourceItemLinks.check.ts.
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: this check performs real writes against a disposable check database only.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  const adminConnectionString = process.env.ADMIN_DATABASE_URL;
  if (!adminConnectionString) {
    throw new Error('ADMIN_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  async function fetchCandidate(id: number) {
    const [row] = await db.select().from(discoveryCandidates).where(eq(discoveryCandidates.id, id));
    return row;
  }
  async function fetchObservation(id: number) {
    const [row] = await db
      .select()
      .from(discoveryCandidateObservations)
      .where(eq(discoveryCandidateObservations.id, id));
    return row;
  }

  // Every ingestion_jobs row this check creates -- directly, or via
  // claimEligibleCandidatesForPromotion -- gets tracked here so the
  // top-level finally block can mark all of them permanently
  // non-claimable, regardless of which candidate a given promotion batch
  // happened to sweep up (a batch size of 50 against a shared check
  // database can and does pick up eligible candidates left over from
  // earlier sections of this same run, not only the one section under
  // test at that moment).
  const createdIngestionJobIds: number[] = [];

  async function promoteAndTrack(batchSize: number): Promise<PromotedCandidate[]> {
    const result = await claimEligibleCandidatesForPromotion(batchSize);
    createdIngestionJobIds.push(...result.map((p) => p.ingestionJobId));
    return result;
  }

  console.log("=== Discovery candidate ledger (real mutation functions, --conditions=react-server) ===\n");

  const unique = randomUUID();
  const [feedA] = await db
    .insert(discoveryFeeds)
    .values({ sourceId: SEEDED_SOURCE_ID, feedUrl: `https://feed-a-${unique}.example.test/rss` })
    .returning({ id: discoveryFeeds.id });
  const [feedB] = await db
    .insert(discoveryFeeds)
    .values({ sourceId: SEEDED_SOURCE_ID, feedUrl: `https://feed-b-${unique}.example.test/rss` })
    .returning({ id: discoveryFeeds.id });

  try {
  // --- 1. Candidate insertion is forced to 'excluded' by PostgreSQL -------
  {
    const forcedUrl = `https://example.test/forced-excluded-${randomUUID()}`;
    const [row] = await db
      .insert(discoveryCandidates)
      .values({ normalizedUrl: forcedUrl, admissibility: "eligible" })
      .returning({ id: discoveryCandidates.id, admissibility: discoveryCandidates.admissibility });
    assert(
      row!.admissibility === "excluded",
      "a direct INSERT attempting admissibility='eligible' is forced to 'excluded' by the BEFORE INSERT trigger"
    );
  }

  // --- 2. held/eligible observations raise correctly; never lowered ------
  let raiseTestCandidateId!: number;
  {
    const url = `https://example.test/raise-${randomUUID()}`;
    const held = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "held" }));
    if (held.outcome !== "recorded") throw new Error("test setup error: expected 'recorded' outcome");
    raiseTestCandidateId = held.candidateId;

    const afterHeld = await fetchCandidate(held.candidateId);
    assert(afterHeld.admissibility === "held", "a 'held' observation raises a fresh (excluded) candidate to 'held'");

    const eligible = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "eligible" }));
    if (eligible.outcome !== "recorded") throw new Error("test setup error");
    const afterEligible = await fetchCandidate(eligible.candidateId);
    assert(afterEligible.admissibility === "eligible", "a subsequent 'eligible' observation raises 'held' -> 'eligible'");

    const loweringAttempt = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "excluded" }));
    if (loweringAttempt.outcome !== "recorded") throw new Error("test setup error");
    const afterLoweringAttempt = await fetchCandidate(loweringAttempt.candidateId);
    assert(
      afterLoweringAttempt.admissibility === "eligible",
      "a subsequent 'excluded' observation never lowers an already-'eligible' candidate"
    );
  }

  // --- 3. A direct UPDATE lowering admissibility is rejected --------------
  await assertThrows(
    async () => db.update(discoveryCandidates).set({ admissibility: "excluded" }).where(eq(discoveryCandidates.id, raiseTestCandidateId)),
    "a direct UPDATE attempting to lower an 'eligible' candidate's admissibility is rejected"
  );

  // --- 3b. A direct UPDATE RAISING admissibility with no justifying
  // observation on record is ALSO rejected -- the fold must be earned by
  // an actual observation of at least that rank, never merely "not a
  // decrease". This is what closes the gap an earlier revision of
  // restrict_discovery_candidate_mutation() left open: it rejected
  // downward changes but permitted an arbitrary direct
  // UPDATE ... SET admissibility = 'eligible' with no eligible
  // observation anywhere for that candidate. The legitimate path
  // (INSERT observation -> AFTER INSERT raise trigger -> UPDATE
  // candidate) is already proven to still work by section 2 above --
  // this section proves the illegitimate path is now blocked. ---------
  {
    const url = `https://example.test/unjustified-raise-${randomUUID()}`;
    const [freshCandidate] = await db
      .insert(discoveryCandidates)
      .values({ normalizedUrl: url })
      .returning({ id: discoveryCandidates.id });

    await assertThrows(
      async () =>
        db.update(discoveryCandidates).set({ admissibility: "eligible" }).where(eq(discoveryCandidates.id, freshCandidate!.id)),
      "a direct excluded -> eligible UPDATE with no eligible observation on record is rejected"
    );
    await assertThrows(
      async () =>
        db.update(discoveryCandidates).set({ admissibility: "held" }).where(eq(discoveryCandidates.id, freshCandidate!.id)),
      "a direct excluded -> held UPDATE with no held/eligible observation on record is rejected"
    );

    const stillExcluded = await fetchCandidate(freshCandidate!.id);
    assert(
      stillExcluded.admissibility === "excluded",
      "the candidate remains 'excluded' after both rejected direct-raise attempts (neither partially applied)"
    );
  }

  // --- 4. last_seen_at cannot move backwards (candidate + observation) ---
  {
    const url = `https://example.test/backwards-${randomUUID()}`;
    const sighting = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "held" }));
    if (sighting.outcome !== "recorded") throw new Error("test setup error");

    await assertThrows(
      async () =>
        db.update(discoveryCandidates).set({ lastSeenAt: new Date(0) }).where(eq(discoveryCandidates.id, sighting.candidateId)),
      "a direct UPDATE moving discovery_candidates.last_seen_at backwards is rejected"
    );
    await assertThrows(
      async () =>
        db
          .update(discoveryCandidateObservations)
          .set({ lastSeenAt: new Date(0) })
          .where(eq(discoveryCandidateObservations.id, sighting.observationId)),
      "a direct UPDATE moving discovery_candidate_observations.last_seen_at backwards is rejected"
    );
  }

  // --- 5/6. Feed replay: advances both last_seen_at values, one observation row ---
  {
    const url = `https://example.test/replay-${randomUUID()}`;
    const first = await recordDiscoverySighting(
      fakeSighting({ rawUrl: url, discoveryProviderId: RSS_PROVIDER_ID, discoveryFeedId: feedA!.id, admissibility: "held" })
    );
    if (first.outcome !== "recorded") throw new Error("test setup error");

    const beforeCandidate = await fetchCandidate(first.candidateId);
    const beforeObservation = await fetchObservation(first.observationId);

    await sleep(20); // ensure now() genuinely advances between the two sightings

    const replay = await recordDiscoverySighting(
      fakeSighting({ rawUrl: url, discoveryProviderId: RSS_PROVIDER_ID, discoveryFeedId: feedA!.id, admissibility: "held" })
    );
    if (replay.outcome !== "recorded") throw new Error("test setup error");

    assert(replay.candidateId === first.candidateId, "a feed replay resolves to the same candidate");
    assert(replay.observationId === first.observationId, "a feed replay resolves to the SAME observation row, not a new one");

    const afterCandidate = await fetchCandidate(replay.candidateId);
    const afterObservation = await fetchObservation(replay.observationId);
    assert(
      afterObservation.lastSeenAt.getTime() > beforeObservation.lastSeenAt.getTime(),
      "the replayed observation's last_seen_at advances"
    );
    assert(
      afterCandidate.lastSeenAt.getTime() > beforeCandidate.lastSeenAt.getTime(),
      "the parent candidate's last_seen_at ALSO advances on replay (via the candidate upsert path -- the AFTER INSERT raise trigger does not fire on a replay UPDATE)"
    );

    const obsRows = await db
      .select({ id: discoveryCandidateObservations.id })
      .from(discoveryCandidateObservations)
      .where(eq(discoveryCandidateObservations.discoveryCandidateId, first.candidateId));
    assert(obsRows.length === 1, "exactly one observation row exists for this candidate despite two feed sightings (replay collapsed)");
  }

  // --- 7. Two feeds observing the same URL -> one candidate, two observations ---
  {
    const url = `https://example.test/two-feed-${randomUUID()}`;
    const sightingA = await recordDiscoverySighting(
      fakeSighting({ rawUrl: url, discoveryProviderId: RSS_PROVIDER_ID, discoveryFeedId: feedA!.id, admissibility: "held" })
    );
    const sightingB = await recordDiscoverySighting(
      fakeSighting({ rawUrl: url, discoveryProviderId: RSS_PROVIDER_ID, discoveryFeedId: feedB!.id, admissibility: "held" })
    );
    if (sightingA.outcome !== "recorded" || sightingB.outcome !== "recorded") throw new Error("test setup error");

    assert(sightingA.candidateId === sightingB.candidateId, "the same normalized URL produces the same candidate id regardless of feed");
    assert(sightingA.observationId !== sightingB.observationId, "different feeds produce distinct observation rows");

    const obsRows = await db
      .select({ id: discoveryCandidateObservations.id })
      .from(discoveryCandidateObservations)
      .where(eq(discoveryCandidateObservations.discoveryCandidateId, sightingA.candidateId));
    assert(obsRows.length === 2, "exactly two observation rows exist for this candidate (one per feed)");
  }

  // --- 8/9. Composite FK + pairing CHECK -----------------------------------
  let candOneId!: number;
  let candOneObsId!: number;
  let candTwoObsId!: number;
  {
    const urlOne = `https://example.test/composite-one-${randomUUID()}`;
    const urlTwo = `https://example.test/composite-two-${randomUUID()}`;
    const one = await recordDiscoverySighting(fakeSighting({ rawUrl: urlOne, admissibility: "eligible" }));
    const two = await recordDiscoverySighting(fakeSighting({ rawUrl: urlTwo, admissibility: "eligible" }));
    if (one.outcome !== "recorded" || two.outcome !== "recorded") throw new Error("test setup error");
    candOneId = one.candidateId;
    candOneObsId = one.observationId;
    candTwoObsId = two.observationId;

    await assertThrows(
      async () =>
        adminDb.insert(ingestionJobs).values({
          submittedUrl: urlOne,
          normalizedUrl: urlOne,
          discoveryProviderId: MANUAL_PROVIDER_ID,
          initiatedBy: "system",
          status: "queued",
          discoveryCandidateId: candOneId,
          discoveryCandidateObservationId: candTwoObsId, // belongs to candidate TWO, not ONE
        }),
      "the composite FK rejects an observation id that belongs to a different candidate than the paired candidate id"
    );

    const legacyUrl = `https://example.test/legacy-${randomUUID()}`;
    const [legacyJob] = await adminDb
      .insert(ingestionJobs)
      .values({
        submittedUrl: legacyUrl,
        normalizedUrl: legacyUrl,
        discoveryProviderId: MANUAL_PROVIDER_ID,
        initiatedBy: "human",
        status: "queued",
      })
      .returning({
        id: ingestionJobs.id,
        discoveryCandidateId: ingestionJobs.discoveryCandidateId,
        discoveryCandidateObservationId: ingestionJobs.discoveryCandidateObservationId,
      });
    createdIngestionJobIds.push(legacyJob!.id);
    assert(
      legacyJob!.discoveryCandidateId === null && legacyJob!.discoveryCandidateObservationId === null,
      "an ordinary manual/legacy ingestion_jobs insert leaves both new discovery columns NULL and succeeds"
    );

    await assertThrows(
      async () =>
        adminDb.insert(ingestionJobs).values({
          submittedUrl: urlOne,
          normalizedUrl: `${urlOne}-half-a`,
          discoveryProviderId: MANUAL_PROVIDER_ID,
          initiatedBy: "system",
          status: "queued",
          discoveryCandidateId: candOneId,
          // discoveryCandidateObservationId omitted -> NULL
        }),
      "half-populated pairing (candidate id set, observation id NULL) is rejected by the pairing CHECK"
    );

    await assertThrows(
      async () =>
        adminDb.insert(ingestionJobs).values({
          submittedUrl: urlOne,
          normalizedUrl: `${urlOne}-half-b`,
          discoveryProviderId: MANUAL_PROVIDER_ID,
          initiatedBy: "system",
          status: "queued",
          discoveryCandidateObservationId: candOneObsId,
          // discoveryCandidateId omitted -> NULL
        }),
      "half-populated pairing (observation id set, candidate id NULL) is rejected by the pairing CHECK " +
        "(this case would NOT be caught by the composite FK alone -- see deviation note)"
    );
  }

  // --- 10/11. Deterministic promotion origin; one candidate -> one job ---
  {
    const url = `https://example.test/origin-${randomUUID()}`;
    const [cand] = await db.insert(discoveryCandidates).values({ normalizedUrl: url }).returning({ id: discoveryCandidates.id });

    const t0 = new Date(Date.now() - 300_000);
    const t1 = new Date(Date.now() - 200_000);
    const t2 = new Date(Date.now() - 100_000);

    const [earliestEligible] = await db
      .insert(discoveryCandidateObservations)
      .values({
        discoveryCandidateId: cand!.id,
        discoveryProviderId: MANUAL_PROVIDER_ID,
        observedUrl: url,
        admissibility: "eligible",
        firstSeenAt: t0,
        lastSeenAt: t0,
      })
      .returning({ id: discoveryCandidateObservations.id });
    await db.insert(discoveryCandidateObservations).values({
      discoveryCandidateId: cand!.id,
      discoveryProviderId: MANUAL_PROVIDER_ID,
      observedUrl: url,
      admissibility: "held", // not eligible -- must never be chosen as origin
      firstSeenAt: t1,
      lastSeenAt: t1,
    });
    const [laterEligible] = await db
      .insert(discoveryCandidateObservations)
      .values({
        discoveryCandidateId: cand!.id,
        discoveryProviderId: RSS_PROVIDER_ID,
        discoveryFeedId: feedA!.id,
        observedUrl: url,
        admissibility: "eligible",
        firstSeenAt: t2,
        lastSeenAt: t2,
      })
      .returning({ id: discoveryCandidateObservations.id });

    const promoted = await promoteAndTrack(50);
    const thisPromotion = promoted.find((p) => p.candidateId === cand!.id);
    assert(Boolean(thisPromotion), "the candidate with multiple eligible observations is promoted");

    const [job] = await db
      .select({
        discoveryCandidateObservationId: ingestionJobs.discoveryCandidateObservationId,
        discoveryProviderId: ingestionJobs.discoveryProviderId,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.discoveryCandidateId, cand!.id));
    assert(
      job?.discoveryCandidateObservationId === earliestEligible!.id,
      "promotion origin is the EARLIEST eligible observation (first_seen_at ASC), not the later eligible one or the held one"
    );
    assert(
      job?.discoveryCandidateObservationId !== laterEligible!.id,
      "promotion origin is never the later eligible observation"
    );

    await assertThrows(
      async () =>
        adminDb.insert(ingestionJobs).values({
          submittedUrl: url,
          normalizedUrl: `${url}-second-attempt`,
          discoveryProviderId: MANUAL_PROVIDER_ID,
          initiatedBy: "system",
          status: "queued",
          discoveryCandidateId: cand!.id,
          discoveryCandidateObservationId: laterEligible!.id,
        }),
      "a second ingestion_jobs row for an already-promoted candidate is rejected by the unique index (one candidate -> at most one job)"
    );
  }

  // --- 10c. Promotion preserves the origin observation's exact raw
  // observedUrl as submitted_url -- distinct from normalized_url, which
  // stays the candidate's normalized identity. Uses the same
  // already-supported normalization transformation (tracking-parameter
  // stripping) discoveryFeeds.check.ts already relies on -- no new
  // normalization logic. ---------------------------------------------
  {
    const rawUrlWithTracking = `https://example.test/tracked-${randomUUID()}/?utm_source=discovery-check`;
    const expectedNormalized = normalizeUrl(rawUrlWithTracking);
    if (!expectedNormalized.ok) {
      throw new Error("test setup error: rawUrlWithTracking should normalize successfully");
    }
    assert(
      rawUrlWithTracking !== expectedNormalized.normalizedUrl,
      "sanity check on the test itself: the raw observed URL and its normalized form actually differ (tracking param stripped)"
    );

    const sighting = await recordDiscoverySighting(fakeSighting({ rawUrl: rawUrlWithTracking, admissibility: "eligible" }));
    if (sighting.outcome !== "recorded") throw new Error("test setup error");

    const candidateRow = await fetchCandidate(sighting.candidateId);
    const observationRow = await fetchObservation(sighting.observationId);
    assert(
      observationRow.observedUrl === rawUrlWithTracking,
      "the observation stores the exact raw observed URL, unnormalized"
    );
    assert(
      candidateRow.normalizedUrl === expectedNormalized.normalizedUrl,
      "the candidate stores the normalized form, not the raw observed URL"
    );

    const promoted = await promoteAndTrack(50);
    const thisPromotion = promoted.find((p) => p.candidateId === sighting.candidateId);
    assert(Boolean(thisPromotion), "the tracked-URL candidate is promoted");

    const [job] = await db
      .select({ submittedUrl: ingestionJobs.submittedUrl, normalizedUrl: ingestionJobs.normalizedUrl })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.discoveryCandidateId, sighting.candidateId));
    assert(
      job?.submittedUrl === rawUrlWithTracking,
      "job.submitted_url is the origin observation's raw observed URL, not the normalized candidate URL"
    );
    assert(
      job?.normalizedUrl === expectedNormalized.normalizedUrl,
      "job.normalized_url is the candidate's normalized URL"
    );
  }

  // --- 12. Concurrent promotion never duplicates work ----------------------
  {
    // Part A: a manually-held row lock deterministically causes SKIP LOCKED
    // to skip that candidate, then the candidate becomes claimable again
    // once the lock releases.
    const lockedUrl = `https://example.test/locked-${randomUUID()}`;
    const controlUrl = `https://example.test/control-${randomUUID()}`;
    const lockedSighting = await recordDiscoverySighting(fakeSighting({ rawUrl: lockedUrl, admissibility: "eligible" }));
    const controlSighting = await recordDiscoverySighting(fakeSighting({ rawUrl: controlUrl, admissibility: "eligible" }));
    if (lockedSighting.outcome !== "recorded" || controlSighting.outcome !== "recorded") {
      throw new Error("test setup error");
    }

    const rawClient = new Client({ connectionString: adminConnectionString });
    await rawClient.connect();
    await rawClient.query("BEGIN");
    const lockResult = await rawClient.query("SELECT id FROM discovery_candidates WHERE id = $1 FOR UPDATE", [
      lockedSighting.candidateId,
    ]);
    assert(lockResult.rows.length === 1, "a manual transaction successfully locks the target candidate row");

    const resultWhileLocked = await promoteAndTrack(50);
    const promotedWhileLocked = resultWhileLocked.map((p) => p.candidateId);
    assert(
      !promotedWhileLocked.includes(lockedSighting.candidateId),
      "SKIP LOCKED causes the real promotion function to skip a candidate whose row is held by another transaction"
    );
    assert(
      promotedWhileLocked.includes(controlSighting.candidateId),
      "an unrelated, unlocked eligible candidate IS promoted in the same call"
    );

    await rawClient.query("ROLLBACK");
    await rawClient.end();

    const resultAfterUnlock = await promoteAndTrack(50);
    assert(
      resultAfterUnlock.some((p) => p.candidateId === lockedSighting.candidateId),
      "once the manual lock releases, the previously-skipped candidate becomes claimable and IS promoted"
    );

    // Part B: two genuinely concurrent calls to the real function never
    // promote the same candidate twice, and every candidate ends up with
    // exactly one ingestion_jobs row.
    const raceCandidateIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const url = `https://example.test/race-${randomUUID()}`;
      const sighting = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "eligible" }));
      if (sighting.outcome !== "recorded") throw new Error("test setup error");
      raceCandidateIds.push(sighting.candidateId);
    }

    const [batchA, batchB] = await Promise.all([
      promoteAndTrack(50),
      promoteAndTrack(50),
    ]);
    const combinedRaceIds = [...batchA, ...batchB]
      .map((p) => p.candidateId)
      .filter((id) => raceCandidateIds.includes(id));
    const uniqueCombinedRaceIds = new Set(combinedRaceIds);
    assert(
      uniqueCombinedRaceIds.size === combinedRaceIds.length,
      "no race candidate is returned as promoted by both concurrent calls (no duplicate claim)"
    );
    assert(
      uniqueCombinedRaceIds.size === raceCandidateIds.length,
      `all ${raceCandidateIds.length} race candidates were promoted exactly once, combined across the two concurrent calls (found ${uniqueCombinedRaceIds.size})`
    );

    for (const candidateId of raceCandidateIds) {
      const jobs = await db.select({ id: ingestionJobs.id }).from(ingestionJobs).where(eq(ingestionJobs.discoveryCandidateId, candidateId));
      assert(jobs.length === 1, `race candidate ${candidateId} has exactly one ingestion_jobs row after concurrent promotion`);
    }
  }

  // --- 13. Existing ingestion_jobs.normalized_url blocks promotion ---------
  {
    const url = `https://example.test/blocked-by-job-${randomUUID()}`;
    const [blockingJob] = await adminDb
      .insert(ingestionJobs)
      .values({
        submittedUrl: url,
        normalizedUrl: url,
        discoveryProviderId: MANUAL_PROVIDER_ID,
        initiatedBy: "human",
        status: "queued",
      })
      .returning({ id: ingestionJobs.id });
    createdIngestionJobIds.push(blockingJob!.id);
    const sighting = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "eligible" }));
    if (sighting.outcome !== "recorded") throw new Error("test setup error");

    const promoted = await promoteAndTrack(50);
    assert(
      !promoted.some((p) => p.candidateId === sighting.candidateId),
      "a candidate whose normalized URL already exists in ingestion_jobs (any status/provider) is never promoted"
    );
    const jobsForCandidate = await db
      .select({ id: ingestionJobs.id })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.discoveryCandidateId, sighting.candidateId));
    assert(jobsForCandidate.length === 0, "no ingestion_jobs row is ever created for a candidate blocked by an existing job");
  }

  // --- 14. Existing source_items.normalized_url blocks promotion ----------
  {
    const url = `https://example.test/blocked-by-item-${randomUUID()}`;
    await db.insert(sourceItems).values({
      sourceId: SEEDED_SOURCE_ID,
      itemTypeId: SEEDED_ITEM_TYPE_ID,
      url,
      normalizedUrl: url,
    });
    const sighting = await recordDiscoverySighting(fakeSighting({ rawUrl: url, admissibility: "eligible" }));
    if (sighting.outcome !== "recorded") throw new Error("test setup error");

    const promoted = await promoteAndTrack(50);
    assert(
      !promoted.some((p) => p.candidateId === sighting.candidateId),
      "a candidate whose normalized URL already exists in source_items is never promoted"
    );
  }

  // --- 15. admin_role can INSERT into both ledger tables (sequence grants) ---
  {
    const rawAdminPool = new Pool({ connectionString: adminConnectionString });
    try {
      const rawUrl = `https://example.test/raw-admin-${randomUUID()}`;
      const candidateInsert = await rawAdminPool.query(
        "INSERT INTO discovery_candidates (normalized_url) VALUES ($1) RETURNING id",
        [rawUrl]
      );
      assert(
        candidateInsert.rows.length === 1 && typeof candidateInsert.rows[0].id === "number",
        "admin_role can directly INSERT into discovery_candidates, and its id sequence advances (migration 0028 sequence USAGE grant)"
      );
      const candidateId = candidateInsert.rows[0].id;

      const observationInsert = await rawAdminPool.query(
        `INSERT INTO discovery_candidate_observations
           (discovery_candidate_id, discovery_provider_id, observed_url, admissibility)
         VALUES ($1, $2, $3, 'held') RETURNING id`,
        [candidateId, MANUAL_PROVIDER_ID, rawUrl]
      );
      assert(
        observationInsert.rows.length === 1 && typeof observationInsert.rows[0].id === "number",
        "admin_role can directly INSERT into discovery_candidate_observations, and its id sequence advances"
      );
    } finally {
      await rawAdminPool.end();
    }
  }

  // --- 16. discovery_admissibility_rank() fails closed on every currently
  // defined enum value -- reads the live enum from pg_enum rather than a
  // hardcoded literal, so this check would actually catch a future value
  // added to discovery_admissibility without a matching rank-function
  // update (pre-fix, that would have silently returned NULL rather than
  // raising). --------------------------------------------------------
  {
    const enumRows = await db.execute(
      sql`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'discovery_admissibility'::regtype ORDER BY enumsortorder`
    );
    const enumLabels = (enumRows as unknown as { rows: Array<{ enumlabel: string }> }).rows.map((r) => r.enumlabel);
    assert(enumLabels.length === 3, `pg_enum reports 3 discovery_admissibility values (found ${enumLabels.length})`);

    for (const label of enumLabels) {
      const rankResult = await db.execute(
        sql`SELECT discovery_admissibility_rank(${label}::discovery_admissibility) AS rank`
      );
      const rank = (rankResult as unknown as { rows: Array<{ rank: number | null }> }).rows[0]?.rank;
      assert(rank !== null && rank !== undefined, `discovery_admissibility_rank('${label}') returns a non-null rank (got ${rank})`);
    }
  }

  } // end of the try opened right after feedA/feedB creation
  finally {
    // Cleanup runs even if an assertion above threw, so this check is
    // rerunnable without resetting the database (see this file's header
    // comment). Never DELETEs discovery_candidates/
    // discovery_candidate_observations -- the ledger's append-only
    // design is untouched.
    if (createdIngestionJobIds.length > 0) {
      const terminalPatch = completeWithFailure({
        status: "blocked_by_policy",
        now: new Date(),
        failureReason:
          "Test fixture from discoveryCandidateLedger.check.ts -- not a real policy decision. " +
          "Marked terminal so this check (and any check run after it, e.g. check:ingestion-processor) " +
          "is rerunnable without resetting the database.",
        attemptCount: 0,
      });
      await db.update(ingestionJobs).set(terminalPatch).where(inArray(ingestionJobs.id, createdIngestionJobIds));
    }
    if (feedA && feedB) {
      await db.update(discoveryFeeds).set({ enabled: false }).where(inArray(discoveryFeeds.id, [feedA.id, feedB.id]));
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} discovery candidate ledger check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll discovery candidate ledger checks passed.");
  }
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exitCode = 1;
});
