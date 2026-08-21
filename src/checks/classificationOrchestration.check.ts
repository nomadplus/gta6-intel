/**
 * Regression check for Phase 5 PR 3's ORCHESTRATION BOUNDARY -- the
 * architecture correction that moved the classify_relevance trigger out
 * of src/db/mutations/ingestion.ts and into the server-action layer
 * (src/app/admin/(protected)/ingest/actions.ts calling
 * src/lib/ai/operations/classificationTrigger.ts's triggerClassifyRelevance()).
 *
 * This exercises the REAL finalizeIngestionConfirmation() (completely
 * unchanged, DB-only, no AI knowledge) followed by the REAL
 * triggerClassifyRelevance() (with an injected FakeAiProvider, never a
 * real Anthropic call), proving:
 *
 *   - confirmation commits successfully and returns its sourceItemId
 *     regardless of what classification does next
 *   - a classification failure of EVERY kind (provider error, invalid
 *     structured output, kill switch, budget block) NEVER reverses or
 *     misreports the already-successful confirmation -- the source_item
 *     row persists exactly as confirmed
 *   - the confirmation half of this test needs NO AI configuration at
 *     all; only triggerClassifyRelevance (called separately, after
 *     confirmation has already returned) touches AI_DEFAULT_MODEL /
 *     AI_MONTHLY_BUDGET_USD -- proving finalizeIngestionConfirmation
 *     itself has no such dependency
 *
 * Run with: npx tsx --conditions=react-server src/checks/classificationOrchestration.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, INGESTION_REVIEW_SIGNING_SECRET,
 * LOCAL_FAKE_ADMIN_AUTH_USER_ID, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { aiJobs, aiResults, ingestionJobs, sourceItems } from "../db/schema";
import { finalizeIngestionConfirmation, findOrCreateIngestionJob } from "../db/mutations/ingestion";
import { signReviewPayload } from "../lib/ingestion/reviewPayloadSigning";
import { triggerClassifyRelevance } from "../lib/ai/operations/classificationTrigger";
import { FakeAiProvider } from "./helpers/fakeAiProvider";
import type { AuthorizedAdmin } from "../lib/auth/requireAdmin";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const EDITOR_AUTH_USER_ID = "test-editor-0000-0000-0000-000000000002";
const EDITOR: AuthorizedAdmin = {
  id: 2,
  displayName: "Test Editor",
  email: "editor@example.test",
  role: "editor",
};
const SEEDED_SOURCE_ID = 1;
const SEEDED_ITEM_TYPE_ID = 1;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run: this check performs real writes and relies on the LOCAL_FAKE_ADMIN_AUTH_USER_ID bypass, which must never be exercised against a production database."
    );
  }
  if (!process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID) {
    throw new Error("LOCAL_FAKE_ADMIN_AUTH_USER_ID is not set. See README.md.");
  }
  const checkConnectionString = process.env.CHECK_DATABASE_URL;
  if (!checkConnectionString) {
    throw new Error('CHECK_DATABASE_URL is not set. See README.md ("Test / check commands").');
  }
  if (!process.env.AI_DEFAULT_MODEL) {
    throw new Error("AI_DEFAULT_MODEL is not set -- required by triggerClassifyRelevance()/runAiOperation(), not by finalizeIngestionConfirmation() itself.");
  }
  process.env.LOCAL_FAKE_ADMIN_AUTH_USER_ID = EDITOR_AUTH_USER_ID;

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);
  const createdJobIds: number[] = [];
  const createdSourceItemIds: number[] = [];
  const createdAiJobIds: number[] = [];

  async function confirmFreshIngestionJob(): Promise<number> {
    const testUrl = `https://example.test/pr3-orchestration-check-${randomUUID()}`;
    const { job } = await findOrCreateIngestionJob({
      submittedUrl: testUrl,
      normalizedUrl: testUrl,
      admin: EDITOR,
    });
    createdJobIds.push(job.id);

    await db.update(ingestionJobs).set({ status: "needs_review", sourceItemId: null }).where(eq(ingestionJobs.id, job.id));

    const fakeRawContentHash = "a".repeat(64);
    const reviewToken = signReviewPayload({
      jobId: job.id,
      url: testUrl,
      canonicalUrl: null,
      excerpt: "An ordinary excerpt for the orchestration-boundary check.",
      rawContentHash: fakeRawContentHash,
    });

    const confirmResult = await finalizeIngestionConfirmation({
      jobId: job.id,
      sourceId: SEEDED_SOURCE_ID,
      itemTypeId: SEEDED_ITEM_TYPE_ID,
      reviewToken,
      excerpt: "An ordinary excerpt for the orchestration-boundary check.",
    });
    createdSourceItemIds.push(confirmResult.sourceItemId);
    return confirmResult.sourceItemId;
  }

  async function loadSourceItem(id: number) {
    const [row] = await db.select().from(sourceItems).where(eq(sourceItems.id, id));
    return row;
  }

  try {
    console.log("=== classify_relevance orchestration boundary (Phase 5 PR 3) ===\n");

    // --- confirmation commits and returns successfully; classification
    // succeeds afterward via the SAME trigger a real request would use ---
    {
      const sourceItemId = await confirmFreshIngestionJob();
      const confirmedSnapshot = await loadSourceItem(sourceItemId);
      assert(confirmedSnapshot !== undefined, "confirmation: the source_item row exists immediately after finalizeIngestionConfirmation returns");

      const provider = new FakeAiProvider([
        { kind: "success", rawOutput: { relevance: "relevant", confidence: 0.8, reasoning: "orchestration check" }, tokensIn: 30, tokensOut: 10 },
      ]);
      const classifyResult = await triggerClassifyRelevance(sourceItemId, provider);
      assert(classifyResult.ok === true, "orchestration: triggerClassifyRelevance succeeds via the injected fake provider");
      if (classifyResult.ok) createdAiJobIds.push(classifyResult.jobId);

      const afterSnapshot = await loadSourceItem(sourceItemId);
      assert(
        JSON.stringify(confirmedSnapshot) === JSON.stringify(afterSnapshot),
        "orchestration: the confirmed source_item is unchanged after a SUCCESSFUL post-confirmation classification"
      );
    }

    // --- classification provider error does not reverse confirmation -----
    {
      const sourceItemId = await confirmFreshIngestionJob();
      const confirmedSnapshot = await loadSourceItem(sourceItemId);

      const provider = new FakeAiProvider([{ kind: "provider_error", message: "simulated upstream failure" }]);
      const classifyResult = await triggerClassifyRelevance(sourceItemId, provider);
      assert(classifyResult.ok === false, "orchestration: a provider error is a normal typed failure, not a thrown error");
      if (!classifyResult.ok && classifyResult.jobId !== null) createdAiJobIds.push(classifyResult.jobId);

      const afterSnapshot = await loadSourceItem(sourceItemId);
      assert(
        JSON.stringify(confirmedSnapshot) === JSON.stringify(afterSnapshot),
        "orchestration: a classification PROVIDER ERROR never reverses or alters the already-committed source_item"
      );
    }

    // --- classification kill-switch block does not reverse confirmation --
    {
      const sourceItemId = await confirmFreshIngestionJob();
      const confirmedSnapshot = await loadSourceItem(sourceItemId);

      process.env.AI_KILL_SWITCH_ENGAGED = "true";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { relevance: "relevant", confidence: 0.9, reasoning: "unreachable" } }]);
      const classifyResult = await triggerClassifyRelevance(sourceItemId, provider);
      delete process.env.AI_KILL_SWITCH_ENGAGED;

      assert(classifyResult.ok === false, "orchestration: a kill-switch block is a normal typed failure");
      assert(provider.receivedRequests.length === 0, "orchestration: the provider was never invoked while the kill switch was engaged");
      if (!classifyResult.ok && classifyResult.jobId !== null) createdAiJobIds.push(classifyResult.jobId);

      const afterSnapshot = await loadSourceItem(sourceItemId);
      assert(
        JSON.stringify(confirmedSnapshot) === JSON.stringify(afterSnapshot),
        "orchestration: a classification KILL-SWITCH BLOCK never reverses or alters the already-committed source_item"
      );
    }

    // --- classification budget block does not reverse confirmation -------
    {
      const sourceItemId = await confirmFreshIngestionJob();
      const confirmedSnapshot = await loadSourceItem(sourceItemId);

      const previousBudget = process.env.AI_MONTHLY_BUDGET_USD;
      process.env.AI_MONTHLY_BUDGET_USD = "0";
      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { relevance: "relevant", confidence: 0.9, reasoning: "unreachable" } }]);
      const classifyResult = await triggerClassifyRelevance(sourceItemId, provider);
      if (previousBudget === undefined) delete process.env.AI_MONTHLY_BUDGET_USD;
      else process.env.AI_MONTHLY_BUDGET_USD = previousBudget;

      assert(classifyResult.ok === false, "orchestration: a budget block is a normal typed failure");
      assert(provider.receivedRequests.length === 0, "orchestration: the provider was never invoked with a zero budget ceiling");
      if (!classifyResult.ok && classifyResult.jobId !== null) createdAiJobIds.push(classifyResult.jobId);

      const afterSnapshot = await loadSourceItem(sourceItemId);
      assert(
        JSON.stringify(confirmedSnapshot) === JSON.stringify(afterSnapshot),
        "orchestration: a classification BUDGET BLOCK never reverses or alters the already-committed source_item"
      );
    }

    // --- classification malformed output does not reverse confirmation ---
    {
      const sourceItemId = await confirmFreshIngestionJob();
      const confirmedSnapshot = await loadSourceItem(sourceItemId);

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { relevance: "not-a-real-value" }, tokensIn: 10, tokensOut: 5 }]);
      const classifyResult = await triggerClassifyRelevance(sourceItemId, provider);
      assert(classifyResult.ok === false, "orchestration: malformed structured output is a normal typed failure");
      if (!classifyResult.ok && classifyResult.jobId !== null) createdAiJobIds.push(classifyResult.jobId);

      const afterSnapshot = await loadSourceItem(sourceItemId);
      assert(
        JSON.stringify(confirmedSnapshot) === JSON.stringify(afterSnapshot),
        "orchestration: MALFORMED classification output never reverses or alters the already-committed source_item"
      );
    }

    console.log(failures === 0 ? "\nAll orchestration-boundary checks passed." : `\n${failures} check(s) FAILED.`);
  } finally {
    for (const jobId of createdAiJobIds) {
      await db.delete(aiResults).where(eq(aiResults.aiJobId, jobId));
    }
    for (const jobId of createdAiJobIds) {
      await db.delete(aiJobs).where(eq(aiJobs.id, jobId));
    }
    for (const jobId of createdJobIds) {
      await db.delete(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    }
    for (const sourceItemId of createdSourceItemIds) {
      await db.delete(sourceItems).where(eq(sourceItems.id, sourceItemId));
    }
    delete process.env.AI_KILL_SWITCH_ENGAGED;
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
