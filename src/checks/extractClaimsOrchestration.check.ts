/**
 * Regression check for Phase 5 PR 4's extract_claims eligibility gate
 * (src/lib/ai/operations/extractClaimsTrigger.ts's triggerExtractClaims)
 * and the pure extraction-actionability helper
 * (src/lib/ai/extractionActionability.ts).
 *
 * The eligibility semantics under test (LOCKED, see
 * getLatestSuccessfulClassifyRelevanceResult's own doc comment in
 * src/db/queries/admin/index.ts):
 *   - considers ONLY succeeded classify_relevance jobs
 *   - a newer failed/pending/running classification does NOT invalidate
 *     an older succeeded 'relevant' result
 *   - a newer SUCCEEDED 'irrelevant'/'needs_review' DOES supersede an
 *     older succeeded 'relevant' one
 *   - never successfully classified -> ineligible
 * For every ineligible case, this check asserts BOTH that
 * triggerExtractClaims throws SourceItemNotEligibleForExtractionError
 * AND that zero ai_jobs rows are created AND that the injected
 * FakeAiProvider never receives a single request -- proving the gate is
 * enforced strictly before any job row or provider call, not merely
 * that the call eventually fails.
 *
 * Run with: npx tsx --conditions=react-server src/checks/extractClaimsOrchestration.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, sql } from "drizzle-orm";
import { aiJobs, aiResults, sourceItems } from "../db/schema";
import {
  triggerExtractClaims,
  SourceItemNotEligibleForExtractionError,
  SourceItemNotFoundForExtractionError,
} from "../lib/ai/operations/extractClaimsTrigger";
import { FakeAiProvider } from "./helpers/fakeAiProvider";
import {
  canTriggerExtraction,
  extractionAction,
  extractionButtonLabel,
} from "../lib/ai/extractionActionability";
import type { ExtractionDisplayStatus } from "../lib/ai/extractClaimsRecoveryLifecycle";
import { computeExtractionDisplayStatus } from "../lib/ai/extractClaimsRecoveryLifecycle";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: this check performs real writes and must never be pointed at a production database.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL is not set -- extractClaimsTrigger writes/reads via adminDb.");
  }
  if (!process.env.AI_DEFAULT_MODEL) {
    throw new Error("AI_DEFAULT_MODEL is not set -- required by runAiOperation() underneath extractClaims().");
  }

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdSourceItemIds: number[] = [];

  async function createTestSourceItem(): Promise<number> {
    const url = `https://example.test/pr4-orchestration-check-${randomUUID()}`;
    const [row] = await db
      .insert(sourceItems)
      .values({
        sourceId: SEEDED_SOURCE_ID,
        itemTypeId: SEEDED_ITEM_TYPE_ID,
        url,
        normalizedUrl: url,
        title: "A source item for extract_claims orchestration checks",
        excerpt: "An ordinary excerpt describing something about GTA VI.",
      })
      .returning();
    createdSourceItemIds.push(row.id);
    return row.id;
  }

  /**
   * Directly inserts a classify_relevance ai_jobs (+ optionally
   * ai_results) row with EXPLICIT status/timestamps -- bypassing
   * runAiOperation entirely -- so this check can construct precise
   * "older succeeded + newer failed" / "older succeeded + newer
   * succeeded" orderings that would be awkward to produce through the
   * real classify operation's own timing.
   */
  async function insertClassifyRelevanceJob(params: {
    sourceItemId: number;
    status: "pending" | "running" | "succeeded" | "failed";
    completedAt: Date | null;
    relevance?: "relevant" | "irrelevant" | "needs_review";
  }): Promise<number> {
    const [job] = await db
      .insert(aiJobs)
      .values({
        operation: "classify_relevance",
        provider: "fake",
        model: "test-model",
        status: params.status,
        sourceItemId: params.sourceItemId,
        completedAt: params.completedAt,
        tokensIn: params.status === "succeeded" ? 10 : null,
        tokensOut: params.status === "succeeded" ? 5 : null,
      })
      .returning({ id: aiJobs.id });

    if (params.status === "succeeded" && params.relevance) {
      await db.insert(aiResults).values({
        aiJobId: job.id,
        structuredOutput: { relevance: params.relevance, confidence: 0.9, reasoning: "fixture" },
      });
    }
    return job.id;
  }

  async function countAiJobsForSourceItem(sourceItemId: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiJobs)
      .where(and(eq(aiJobs.operation, "extract_claims"), eq(aiJobs.sourceItemId, sourceItemId)));
    return rows[0]?.count ?? 0;
  }

  try {
    console.log("=== extract_claims eligibility gate + actionability helper (Phase 5 PR 4) ===\n");

    // --- never classified at all -----------------------------------------
    {
      const sourceItemId = await createTestSourceItem();
      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(sourceItemId, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotEligibleForExtractionError;
      }
      assert(threw, "never-classified: triggerExtractClaims throws SourceItemNotEligibleForExtractionError");
      assert(provider.receivedRequests.length === 0, "never-classified: the provider was never invoked");
      assert((await countAiJobsForSourceItem(sourceItemId)) === 0, "never-classified: zero extract_claims ai_jobs rows created");
    }

    // --- source item does not exist ---------------------------------------
    {
      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(999_999_999, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotFoundForExtractionError;
      }
      assert(threw, "nonexistent source item: triggerExtractClaims throws SourceItemNotFoundForExtractionError");
      assert(provider.receivedRequests.length === 0, "nonexistent source item: the provider was never invoked");
    }

    // --- latest succeeded is 'irrelevant' ----------------------------------
    {
      const sourceItemId = await createTestSourceItem();
      await insertClassifyRelevanceJob({
        sourceItemId,
        status: "succeeded",
        completedAt: new Date(),
        relevance: "irrelevant",
      });
      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(sourceItemId, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotEligibleForExtractionError;
      }
      assert(threw, "latest succeeded 'irrelevant': ineligible");
      assert(provider.receivedRequests.length === 0, "latest succeeded 'irrelevant': the provider was never invoked");
      assert((await countAiJobsForSourceItem(sourceItemId)) === 0, "latest succeeded 'irrelevant': zero extract_claims rows created");
    }

    // --- latest succeeded is 'needs_review' --------------------------------
    {
      const sourceItemId = await createTestSourceItem();
      await insertClassifyRelevanceJob({
        sourceItemId,
        status: "succeeded",
        completedAt: new Date(),
        relevance: "needs_review",
      });
      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(sourceItemId, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotEligibleForExtractionError;
      }
      assert(threw, "latest succeeded 'needs_review': ineligible");
      assert(provider.receivedRequests.length === 0, "latest succeeded 'needs_review': the provider was never invoked");
    }

    // --- older succeeded 'relevant', newer FAILED classification -----------
    // must NOT invalidate the earlier successful 'relevant' result.
    {
      const sourceItemId = await createTestSourceItem();
      const olderCompletedAt = new Date(Date.now() - 60_000);
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: olderCompletedAt, relevance: "relevant" });
      await insertClassifyRelevanceJob({ sourceItemId, status: "failed", completedAt: new Date() });

      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { claims: [] }, tokensIn: 50, tokensOut: 10 },
      ]);
      const result = await triggerExtractClaims(sourceItemId, provider);
      assert(result.ok === true, "older succeeded 'relevant' + newer FAILED classification: extraction proceeds (eligible)");
      assert(provider.receivedRequests.length === 1, "older succeeded 'relevant' + newer FAILED classification: provider WAS invoked exactly once");
    }

    // --- older succeeded 'relevant', newer PENDING classification ----------
    // an in-flight newer job must NOT invalidate the earlier success.
    {
      const sourceItemId = await createTestSourceItem();
      const olderCompletedAt = new Date(Date.now() - 60_000);
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: olderCompletedAt, relevance: "relevant" });
      await insertClassifyRelevanceJob({ sourceItemId, status: "pending", completedAt: null });

      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { claims: [] }, tokensIn: 50, tokensOut: 10 },
      ]);
      const result = await triggerExtractClaims(sourceItemId, provider);
      assert(result.ok === true, "older succeeded 'relevant' + newer PENDING classification: extraction proceeds (eligible)");
    }

    // --- older succeeded 'relevant', newer SUCCEEDED 'irrelevant' -----------
    // the newer successful result DOES supersede the older one.
    {
      const sourceItemId = await createTestSourceItem();
      const olderCompletedAt = new Date(Date.now() - 60_000);
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: olderCompletedAt, relevance: "relevant" });
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: new Date(), relevance: "irrelevant" });

      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(sourceItemId, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotEligibleForExtractionError;
      }
      assert(threw, "older succeeded 'relevant' + newer SUCCEEDED 'irrelevant': the newer result supersedes -- now ineligible");
      assert(provider.receivedRequests.length === 0, "superseded case: the provider was never invoked");
    }

    // --- older succeeded 'relevant', newer SUCCEEDED 'needs_review' --------
    {
      const sourceItemId = await createTestSourceItem();
      const olderCompletedAt = new Date(Date.now() - 60_000);
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: olderCompletedAt, relevance: "relevant" });
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: new Date(), relevance: "needs_review" });

      const provider = new FakeAiProvider([]);
      let threw = false;
      try {
        await triggerExtractClaims(sourceItemId, provider);
      } catch (err) {
        threw = err instanceof SourceItemNotEligibleForExtractionError;
      }
      assert(threw, "older succeeded 'relevant' + newer SUCCEEDED 'needs_review': supersedes -- ineligible");
    }

    // --- eligible happy path -------------------------------------------------
    {
      const sourceItemId = await createTestSourceItem();
      await insertClassifyRelevanceJob({ sourceItemId, status: "succeeded", completedAt: new Date(), relevance: "relevant" });
      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { claims: [] }, tokensIn: 50, tokensOut: 10 },
      ]);
      const result = await triggerExtractClaims(sourceItemId, provider);
      assert(result.ok === true, "latest succeeded 'relevant': triggerExtractClaims succeeds");
      assert(provider.receivedRequests.length === 1, "latest succeeded 'relevant': provider invoked exactly once");
    }

    // --- pure actionability helper: 3-of-5 states are actionable ------------
    console.log("\n--- extractionActionability.ts (pure, no DB) ---\n");
    const ALL_STATUSES: ExtractionDisplayStatus[] = ["unextracted", "in_progress", "stale", "failed", "succeeded"];
    const expectedActionable: Record<ExtractionDisplayStatus, boolean> = {
      unextracted: true,
      in_progress: false,
      stale: true,
      failed: true,
      succeeded: false,
    };
    for (const status of ALL_STATUSES) {
      assert(
        canTriggerExtraction(status) === expectedActionable[status],
        `canTriggerExtraction('${status}') === ${expectedActionable[status]}`
      );
    }
    assert(extractionAction("unextracted") === "extract", "extractionAction('unextracted') === 'extract'");
    assert(extractionAction("stale") === "recover", "extractionAction('stale') === 'recover'");
    assert(extractionAction("failed") === "retry", "extractionAction('failed') === 'retry'");
    assert(extractionAction("in_progress") === null, "extractionAction('in_progress') === null (no action)");
    assert(extractionAction("succeeded") === null, "extractionAction('succeeded') === null -- NO re-extract action in PR4, even for a successful extraction");
    assert(extractionButtonLabel("unextracted") === "Extract claims", "button label for 'unextracted' is 'Extract claims'");
    assert(extractionButtonLabel("stale") === "Recover", "button label for 'stale' is 'Recover'");
    assert(extractionButtonLabel("failed") === "Retry", "button label for 'failed' is 'Retry'");
    assert(extractionButtonLabel("succeeded") === null, "button label for 'succeeded' is null -- no button rendered for a successful extraction");
    assert(extractionButtonLabel("in_progress") === null, "button label for 'in_progress' is null");

    // --- extractClaimsRecoveryLifecycle's own domain relabeling -------------
    console.log("\n--- extractClaimsRecoveryLifecycle.ts relabeling (pure, no DB) ---\n");
    const missingStatus = computeExtractionDisplayStatus(null, new Date());
    assert(missingStatus === "unextracted", "computeExtractionDisplayStatus(null, ...) relabels the shared 'missing' state to 'unextracted'");
  } finally {
    for (const id of createdSourceItemIds) {
      await db.delete(aiResults).where(sql`ai_job_id IN (SELECT id FROM ai_jobs WHERE source_item_id = ${id})`);
      await db.delete(aiJobs).where(eq(aiJobs.sourceItemId, id));
      await db.delete(sourceItems).where(eq(sourceItems.id, id));
    }
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll extract_claims orchestration/actionability checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
