/**
 * Regression check for Phase 5 PR 8b's analyse_provenance orchestration:
 * the operation-level persistence (src/lib/ai/operations/analyseProvenance.ts,
 * exercised through the real runAiOperation()) AND the trigger-level
 * cluster-loading/eligibility logic
 * (src/lib/ai/operations/analyseProvenanceTrigger.ts), against a REAL
 * local Postgres database, using ONLY FakeAiProvider -- never a real
 * Anthropic API call.
 *
 * Covers:
 *   - anchor claim not found -> ProvenanceAnchorClaimNotFoundError
 *   - cluster size 0 -> kind 'no_analysable_cluster', zero provider calls,
 *     zero ai_jobs rows
 *   - cluster size 1 -> kind 'no_analysable_cluster', zero provider calls,
 *     zero ai_jobs rows
 *   - cluster size 2 -> a real provider call happens (kind 'ran')
 *   - the cluster is capped at PROVENANCE_CLUSTER_HARD_CAP even when more
 *     source items are linked
 *   - a valid multi-edge result persists correctly, linked via
 *     ai_jobs.provenance_claim_id, with provenance_cluster_fingerprint
 *     populated
 *   - a FABRICATED fromSourceItemId/toSourceItemId is rejected as
 *     invalid_structured_output, zero ai_results rows
 *   - a self-referencing pair (fromSourceItemId === toSourceItemId) is
 *     rejected
 *   - "original" is NOT an AI-proposable relationship type -- rejected by
 *     the schema
 *   - independent_corroboration WITHOUT distinctEvidenceSummary is
 *     rejected; WITH one of valid length succeeds
 *   - distinctEvidenceSummary identical to reasoning is rejected
 *     ("must not simply duplicate reasoning")
 *   - a duplicate directed pair, or the SAME pair in both directions,
 *     within one result is rejected
 *   - the operation-specific output-token bound
 *     (ANALYSE_PROVENANCE_MAX_OUTPUT_TOKENS) is forwarded to the provider
 *     request
 *   - claim-scoped in-flight concurrency race: two simultaneous attempts
 *     for the SAME anchor claim, exactly one succeeds
 *   - ai_jobs_provenance_operation_consistency CHECK rejects an
 *     analyse_provenance job with NULL provenance_claim_id, and rejects a
 *     non-analyse_provenance job with provenance_claim_id populated
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/analyseProvenanceOrchestration.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and } from "drizzle-orm";
import { aiJobs, aiResults, claims, projects, sources, sourceItems, sourceTypes, sourceItemTypes, claimSources } from "../db/schema";
import {
  triggerAnalyseProvenance,
  ProvenanceAnchorClaimNotFoundError,
} from "../lib/ai/operations/analyseProvenanceTrigger";
import {
  analyseProvenance,
  ANALYSE_PROVENANCE_MAX_OUTPUT_TOKENS,
  PROVENANCE_CLUSTER_HARD_CAP,
} from "../lib/ai/operations/analyseProvenance";
import { computeClusterFingerprint } from "../lib/ai/provenanceClusterFingerprint";
import { createPendingAiJob } from "../db/mutations/aiJobs";
import { FakeAiProvider } from "./helpers/fakeAiProvider";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this check performs real database writes.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  if (!process.env.ADMIN_DATABASE_URL) throw new Error("ADMIN_DATABASE_URL is not set -- analyseProvenance writes via adminDb, same as every other admin mutation.");
  if (!process.env.AI_DEFAULT_MODEL) throw new Error("AI_DEFAULT_MODEL is not set -- required by runAiOperation() underneath analyseProvenance().");

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  async function createTestProject(): Promise<number> {
    const [row] = await db.insert(projects).values({ slug: `pr8b-orch-project-${randomUUID()}`, name: "PR8b orchestration fixture project" }).returning();
    return row.id;
  }

  async function createTestClaim(projectId: number, statement: string): Promise<{ id: number; statement: string }> {
    const [row] = await db.insert(claims).values({ projectId, slug: `pr8b-orch-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return { id: row.id, statement: row.statement };
  }

  const [aSourceType] = await db.select().from(sourceTypes).limit(1);
  const [aSourceItemType] = await db.select().from(sourceItemTypes).limit(1);
  if (!aSourceType || !aSourceItemType) throw new Error("Seed data missing: expected at least one source_types/source_item_types row. Run npm run db:seed first.");

  async function createTestSourceItem(title: string, url: string): Promise<{ id: number; title: string | null; url: string; publishedAt: Date | null; excerpt: string | null }> {
    const [src] = await db.insert(sources).values({ name: `PR8b fixture source ${randomUUID()}`, sourceTypeId: aSourceType.id }).returning();
    const [item] = await db
      .insert(sourceItems)
      .values({ sourceId: src.id, itemTypeId: aSourceItemType.id, url, title, publishedAt: new Date("2024-01-01T00:00:00Z"), excerpt: "Fixture excerpt." })
      .returning();
    return { id: item.id, title: item.title, url: item.url, publishedAt: item.publishedAt, excerpt: item.excerpt };
  }

  async function linkClaimSource(claimId: number, sourceItemId: number): Promise<void> {
    await db.insert(claimSources).values({ claimId, sourceItemId, stance: "supports" });
  }

  async function countProvenanceJobs(claimId: number): Promise<number> {
    const rows = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.operation, "analyse_provenance"), eq(aiJobs.provenanceClaimId, claimId)));
    return rows.length;
  }

  async function loadJob(jobId: number) {
    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    return row;
  }

  async function loadResultsForJob(jobId: number) {
    return db.select().from(aiResults).where(eq(aiResults.aiJobId, jobId));
  }

  try {
    console.log("=== analyse_provenance orchestration (Phase 5 PR 8b) -- fake provider only ===\n");

    // --- anchor claim not found ---------------------------------------------
    {
      try {
        await triggerAnalyseProvenance(999999999, new FakeAiProvider([]));
        assert(false, "anchor claim not found: should have thrown");
      } catch (err) {
        assert(err instanceof ProvenanceAnchorClaimNotFoundError, "anchor claim not found: throws ProvenanceAnchorClaimNotFoundError");
      }
    }

    // --- cluster size 0: no_analysable_cluster, zero jobs -------------------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Zero-source fixture claim.");
      const provider = new FakeAiProvider([]);
      const result = await triggerAnalyseProvenance(claim.id, provider);
      assert(result.kind === "no_analysable_cluster", "cluster size 0: kind is 'no_analysable_cluster'");
      assert(provider.receivedRequests.length === 0, "cluster size 0: zero provider calls");
      assert((await countProvenanceJobs(claim.id)) === 0, "cluster size 0: zero analyse_provenance ai_jobs rows");
    }

    // --- cluster size 1: no_analysable_cluster, zero jobs -------------------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "One-source fixture claim.");
      const item = await createTestSourceItem("Only item", "https://example.test/only-item");
      await linkClaimSource(claim.id, item.id);

      const provider = new FakeAiProvider([]);
      const result = await triggerAnalyseProvenance(claim.id, provider);
      assert(result.kind === "no_analysable_cluster", "cluster size 1: kind is 'no_analysable_cluster'");
      assert(provider.receivedRequests.length === 0, "cluster size 1: zero provider calls");
      assert((await countProvenanceJobs(claim.id)) === 0, "cluster size 1: zero analyse_provenance ai_jobs rows");
    }

    // --- cluster size 2: a real call happens, valid multi-edge result persists ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "GTA VI is set in a fictionalized version of Miami called Vice City.");
      const itemA = await createTestSourceItem("Original report", "https://example.test/original");
      const itemB = await createTestSourceItem("Citing report", "https://example.test/citing");
      await linkClaimSource(claim.id, itemA.id);
      await linkClaimSource(claim.id, itemB.id);

      const provider = new FakeAiProvider([
        {
          kind: "success",
          rawOutput: {
            edges: [
              { fromSourceItemId: itemB.id, toSourceItemId: itemA.id, relationshipType: "citation", basis: "Direct link in paragraph 2.", confidence: 0.9, reasoning: "Citing report explicitly links to the original." },
            ],
          },
          tokensIn: 120,
          tokensOut: 60,
        },
      ]);

      const result = await triggerAnalyseProvenance(claim.id, provider);
      assert(result.kind === "ran", "cluster size 2: kind is 'ran'");
      assert(provider.receivedRequests.length === 1, "cluster size 2: exactly one provider call");

      if (result.kind === "ran") {
        assert(result.result.ok === true, "cluster size 2: runAiOperation reports ok:true");
        if (result.result.ok) {
          const job = await loadJob(result.result.jobId);
          assert(job.status === "succeeded", "cluster size 2: job status is 'succeeded'");
          assert(job.provenanceClaimId === claim.id, "cluster size 2: ai_jobs.provenance_claim_id is the anchor claim's id");
          assert(job.provenanceClusterFingerprint !== null, "cluster size 2: ai_jobs.provenance_cluster_fingerprint is populated");
          assert(job.provenanceClusterFingerprint === result.clusterFingerprint, "cluster size 2: persisted fingerprint matches the trigger's own returned fingerprint");
          assert(job.tokensIn === 120 && job.tokensOut === 60, "cluster size 2: token counts persisted");

          const results = await loadResultsForJob(result.result.jobId);
          assert(results.length === 1, "cluster size 2: exactly one ai_results row");
          assert(results[0].confidence === null && results[0].reasoning === null, "cluster size 2: ai_results.confidence/reasoning stay NULL at the top level (per-edge values live inside structured_output)");
        }
      }
    }

    // --- cluster hard cap enforced even with more linked source items -------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Large-cluster fixture claim.");
      const totalToLink = PROVENANCE_CLUSTER_HARD_CAP + 5;
      for (let i = 0; i < totalToLink; i++) {
        const item = await createTestSourceItem(`Large cluster item ${i}`, `https://example.test/large-${randomUUID()}`);
        await linkClaimSource(claim.id, item.id);
      }
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      await triggerAnalyseProvenance(claim.id, provider);
      assert(provider.receivedRequests.length === 1, "hard cap: exactly one provider call");
      const promptItemCount = (provider.receivedRequests[0].userPrompt.match(/title="/g) ?? []).length;
      assert(
        promptItemCount === PROVENANCE_CLUSTER_HARD_CAP,
        `hard cap: exactly PROVENANCE_CLUSTER_HARD_CAP (${PROVENANCE_CLUSTER_HARD_CAP}) items are sent to the model despite ${totalToLink} being linked, got ${promptItemCount}`
      );
    }

    // --- fabricated ids, self-reference, "original" rejected at schema level ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Validation fixture claim.");
      const itemA = await createTestSourceItem("Item A", "https://example.test/valid-a");
      const itemB = await createTestSourceItem("Item B", "https://example.test/valid-b");

      async function expectInvalid(rawOutput: unknown, label: string) {
        const provider = new FakeAiProvider([{ kind: "success", rawOutput }]);
        const result = await analyseProvenance({
          provider,
          claimId: claim.id,
          claimStatement: claim.statement,
          clusterItems: [
            { id: itemA.id, title: itemA.title, url: itemA.url, publishedAt: null, excerpt: null },
            { id: itemB.id, title: itemB.title, url: itemB.url, publishedAt: null, excerpt: null },
          ],
          clusterFingerprint: "fixture-fingerprint",
        });
        assert(result.ok === false, `${label}: runAiOperation reports ok:false`);
        if (!result.ok) {
          assert(result.reason === "invalid_structured_output", `${label}: reason is invalid_structured_output (got ${result.reason})`);
        }
      }

      await expectInvalid(
        { edges: [{ fromSourceItemId: 999999999, toSourceItemId: itemB.id, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r" }] },
        "fabricated fromSourceItemId"
      );
      await expectInvalid(
        { edges: [{ fromSourceItemId: itemA.id, toSourceItemId: itemA.id, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r" }] },
        "self-referencing pair"
      );
      await expectInvalid(
        { edges: [{ fromSourceItemId: itemA.id, toSourceItemId: itemB.id, relationshipType: "original", basis: "b", confidence: 0.5, reasoning: "r" }] },
        "'original' is not AI-proposable"
      );
      await expectInvalid(
        { edges: [{ fromSourceItemId: itemA.id, toSourceItemId: itemB.id, relationshipType: "independent_corroboration", basis: "b", confidence: 0.5, reasoning: "Independently sourced from a named contact." }] },
        "independent_corroboration WITHOUT distinctEvidenceSummary"
      );
      await expectInvalid(
        {
          edges: [
            {
              fromSourceItemId: itemA.id,
              toSourceItemId: itemB.id,
              relationshipType: "independent_corroboration",
              basis: "b",
              confidence: 0.5,
              reasoning: "Independently sourced from a named contact.",
              distinctEvidenceSummary: "Independently sourced from a named contact.",
            },
          ],
        },
        "distinctEvidenceSummary identical to reasoning (must not simply duplicate)"
      );
      await expectInvalid(
        {
          edges: [
            { fromSourceItemId: itemA.id, toSourceItemId: itemB.id, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r1" },
            { fromSourceItemId: itemA.id, toSourceItemId: itemB.id, relationshipType: "repetition", basis: "b2", confidence: 0.4, reasoning: "r2" },
          ],
        },
        "duplicate directed pair within one result"
      );
      await expectInvalid(
        {
          edges: [
            { fromSourceItemId: itemA.id, toSourceItemId: itemB.id, relationshipType: "citation", basis: "b", confidence: 0.5, reasoning: "r1" },
            { fromSourceItemId: itemB.id, toSourceItemId: itemA.id, relationshipType: "citation", basis: "b2", confidence: 0.4, reasoning: "r2" },
          ],
        },
        "the SAME pair in both directions within one result"
      );

      // --- valid independent_corroboration with a proper distinct summary ---
      {
        const provider = new FakeAiProvider([
          {
            kind: "success",
            rawOutput: {
              edges: [
                {
                  fromSourceItemId: itemA.id,
                  toSourceItemId: itemB.id,
                  relationshipType: "independent_corroboration",
                  basis: "Different named sources, no shared phrasing.",
                  confidence: 0.7,
                  reasoning: "Independently sourced from a named industry contact.",
                  distinctEvidenceSummary: "Item A names a distinct contact never mentioned by item B.",
                },
              ],
            },
            tokensIn: 10,
            tokensOut: 10,
          },
        ]);
        const result = await analyseProvenance({
          provider,
          claimId: claim.id,
          claimStatement: claim.statement,
          clusterItems: [
            { id: itemA.id, title: itemA.title, url: itemA.url, publishedAt: null, excerpt: null },
            { id: itemB.id, title: itemB.title, url: itemB.url, publishedAt: null, excerpt: null },
          ],
          clusterFingerprint: "fixture-fingerprint-2",
        });
        assert(result.ok === true, "valid independent_corroboration with a proper distinctEvidenceSummary: ok:true");
      }
    }

    // --- output-token bound is forwarded to the provider request -----------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Token-bound fixture claim.");
      const itemA = await createTestSourceItem("Token item A", "https://example.test/tok-a");
      const itemB = await createTestSourceItem("Token item B", "https://example.test/tok-b");
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      await analyseProvenance({
        provider,
        claimId: claim.id,
        claimStatement: claim.statement,
        clusterItems: [
          { id: itemA.id, title: itemA.title, url: itemA.url, publishedAt: null, excerpt: null },
          { id: itemB.id, title: itemB.title, url: itemB.url, publishedAt: null, excerpt: null },
        ],
        clusterFingerprint: computeClusterFingerprint([
          { id: itemA.id, title: itemA.title, url: itemA.url, publishedAt: null, excerpt: null },
          { id: itemB.id, title: itemB.title, url: itemB.url, publishedAt: null, excerpt: null },
        ]),
      });
      assert(provider.receivedRequests.length === 1, "token bound: exactly one provider request was made");
      assert(
        provider.receivedRequests[0].maxOutputTokens === ANALYSE_PROVENANCE_MAX_OUTPUT_TOKENS,
        `token bound: the request's maxOutputTokens is ANALYSE_PROVENANCE_MAX_OUTPUT_TOKENS (${ANALYSE_PROVENANCE_MAX_OUTPUT_TOKENS}), got ${provider.receivedRequests[0].maxOutputTokens}`
      );
    }

    // --- claim-scoped in-flight concurrency race ----------------------------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Concurrency-race fixture claim.");
      const first = await createPendingAiJob({ operation: "analyse_provenance", provider: "fake", model: "test-model", provenanceClaimId: claim.id });
      const second = await createPendingAiJob({ operation: "analyse_provenance", provider: "fake", model: "test-model", provenanceClaimId: claim.id });
      assert(first.ok === true, "concurrency race: the first pending job is created");
      assert(second.ok === false && second.reason === "already_in_flight", "concurrency race: the second SIMULTANEOUS attempt for the SAME anchor claim is rejected as already_in_flight");
      assert((await countProvenanceJobs(claim.id)) === 1, "concurrency race: exactly one ai_jobs row exists for this anchor claim");
    }

    // --- ai_jobs_provenance_operation_consistency CHECK ---------------------
    {
      let rejectedNullProvenanceClaimId = false;
      try {
        await db.insert(aiJobs).values({ operation: "analyse_provenance", provider: "fake", model: "test-model", status: "pending", provenanceClaimId: null });
      } catch {
        rejectedNullProvenanceClaimId = true;
      }
      assert(rejectedNullProvenanceClaimId, "CHECK constraint: an analyse_provenance job with NULL provenance_claim_id is rejected by the database");

      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "CHECK-constraint fixture claim.");
      let rejectedPopulatedOnOtherOperation = false;
      try {
        await db.insert(aiJobs).values({ operation: "classify_relevance", provider: "fake", model: "test-model", status: "pending", provenanceClaimId: claim.id });
      } catch {
        rejectedPopulatedOnOtherOperation = true;
      }
      assert(
        rejectedPopulatedOnOtherOperation,
        "CHECK constraint: a NON-analyse_provenance job with provenance_claim_id populated is rejected by the database"
      );
    }
  } finally {
    // Deliberately no incremental row cleanup here, matching
    // compareClaimsOrchestration.check.ts's own established convention.
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll analyse_provenance orchestration checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
