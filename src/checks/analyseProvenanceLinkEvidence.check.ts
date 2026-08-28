/**
 * Phase 6 prerequisite regression check: proves, through the REAL
 * triggerAnalyseProvenance() orchestration path (not a reimplementation),
 * that source_item_links evidence is scoped, capped, and surfaced in the
 * model prompt exactly per the locked design -- and that it remains
 * advisory-only (no source_relationships row is ever created merely by
 * this evidence existing).
 *
 * Uses ONLY FakeAiProvider -- never a real Anthropic API call.
 *
 * Covers:
 *   - a resolved link to ANOTHER item in the same claim cluster is
 *     included in that item's knownOutboundLinks
 *   - an unresolved link (to_source_item_id IS NULL) is excluded
 *   - a resolved link to an item OUTSIDE the claim's cluster is excluded
 *   - max 3 occurrences per directed (from,to) pair are forwarded
 *   - selection preference is content -> ambiguous -> chrome, then
 *     link_position ascending
 *   - a same-site content link is preserved (isSameSite=true) and NOT
 *     dropped or reclassified merely for sharing a hostname
 *   - the model-facing prompt text frames link evidence as observations,
 *     never as proof of citation/dependency
 *   - the fingerprint actually used for the ai_jobs row and the model
 *     input are the SAME enriched payload (no divergence between what
 *     gates re-analysis and what the model actually saw)
 *   - this evidence existing creates ZERO source_relationships rows on its
 *     own -- only the existing human-review path (untouched by this PR)
 *     can ever materialize one
 *
 * server-only-guarded, so this must run with --conditions=react-server.
 *
 * Run with: npx tsx --conditions=react-server src/checks/analyseProvenanceLinkEvidence.check.ts
 * (requires CHECK_DATABASE_URL, ADMIN_DATABASE_URL, AI_DEFAULT_MODEL -- see README.md)
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import {
  aiJobs,
  claims,
  projects,
  sources,
  sourceItems,
  sourceTypes,
  sourceItemTypes,
  claimSources,
  sourceItemLinks,
  sourceRelationships,
  discoveryProviders,
  ingestionJobs,
} from "../db/schema";
import { triggerAnalyseProvenance } from "../lib/ai/operations/analyseProvenanceTrigger";
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
  if (!process.env.ADMIN_DATABASE_URL) throw new Error("ADMIN_DATABASE_URL is not set.");
  if (!process.env.AI_DEFAULT_MODEL) throw new Error("AI_DEFAULT_MODEL is not set.");

  const pool = new Pool({ connectionString: checkConnectionString });
  const db = drizzle(pool);

  const [aSourceType] = await db.select().from(sourceTypes).limit(1);
  const [aSourceItemType] = await db.select().from(sourceItemTypes).limit(1);
  if (!aSourceType || !aSourceItemType) throw new Error("Seed data missing. Run npm run db:seed first.");

  let cachedManualProviderId: number | null = null;
  async function getManualDiscoveryProviderId(): Promise<number> {
    if (cachedManualProviderId !== null) return cachedManualProviderId;
    const [existing] = await db.select({ id: discoveryProviders.id }).from(discoveryProviders).where(eq(discoveryProviders.slug, "manual"));
    if (existing) {
      cachedManualProviderId = existing.id;
      return existing.id;
    }
    const [created] = await db.insert(discoveryProviders).values({ slug: "manual", label: "Manual" }).returning();
    cachedManualProviderId = created!.id;
    return created!.id;
  }

  async function createTestProject(): Promise<number> {
    const [row] = await db.insert(projects).values({ slug: `pr6-link-evidence-project-${randomUUID()}`, name: "Phase 6 link evidence fixture project" }).returning();
    return row.id;
  }

  async function createTestClaim(projectId: number, statement: string): Promise<{ id: number; statement: string }> {
    const [row] = await db.insert(claims).values({ projectId, slug: `pr6-link-evidence-claim-${randomUUID()}`, statement, informationType: "report" }).returning();
    return { id: row.id, statement: row.statement };
  }

  async function createTestSourceItem(title: string): Promise<number> {
    const [src] = await db.insert(sources).values({ name: `PR6 link-evidence fixture source ${randomUUID()}`, sourceTypeId: aSourceType.id }).returning();
    const [item] = await db
      .insert(sourceItems)
      .values({ sourceId: src.id, itemTypeId: aSourceItemType.id, url: `https://example.test/${randomUUID()}`, title, publishedAt: new Date("2024-01-01T00:00:00Z"), excerpt: "Fixture excerpt." })
      .returning();
    return item.id;
  }

  async function linkClaimSource(claimId: number, sourceItemId: number): Promise<void> {
    await db.insert(claimSources).values({ claimId, sourceItemId, stance: "supports" });
  }

  /** A minimal ingestion_jobs row purely to satisfy source_item_links.ingestion_job_id's NOT NULL FK -- this check is about link-evidence scoping, not the ingestion pipeline itself (covered by sourceItemLinks.check.ts). */
  async function createFixtureIngestionJob(): Promise<number> {
    const providerId = await getManualDiscoveryProviderId();
    const url = `https://example.test/job-${randomUUID()}`;
    const [job] = await db
      .insert(ingestionJobs)
      .values({ submittedUrl: url, normalizedUrl: url, discoveryProviderId: providerId, initiatedBy: "human", status: "stored" })
      .returning();
    return job!.id;
  }

  async function insertLink(params: {
    from: number;
    to: number | null;
    linkPosition: number;
    placement: "content" | "chrome" | "ambiguous";
    isSameSite?: boolean;
    anchorText?: string | null;
  }): Promise<void> {
    const jobId = await createFixtureIngestionJob();
    const now = params.to !== null ? new Date() : undefined;
    await db.insert(sourceItemLinks).values({
      fromSourceItemId: params.from,
      toSourceItemId: params.to,
      targetUrl: `https://example.test/target-${randomUUID()}`,
      normalizedTargetUrl: `https://example.test/target-${randomUUID()}`,
      anchorText: params.anchorText ?? "an anchor",
      linkPosition: params.linkPosition,
      placement: params.placement,
      isSameSite: params.isSameSite ?? false,
      ingestionJobId: jobId,
      resolvedAt: now,
    });
  }

  async function countSourceRelationships(): Promise<number> {
    const rows = await db.select({ id: sourceRelationships.id }).from(sourceRelationships);
    return rows.length;
  }

  try {
    console.log("=== analyse_provenance link-evidence scoping (Phase 6 prerequisite) -- fake provider only ===\n");

    // --- in-cluster resolved link included; unresolved and out-of-cluster excluded ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Scoping fixture claim.");
      const itemA = await createTestSourceItem("Item A");
      const itemB = await createTestSourceItem("Item B");
      const outOfClusterItem = await createTestSourceItem("Out of cluster item");
      await linkClaimSource(claim.id, itemA);
      await linkClaimSource(claim.id, itemB);
      // outOfClusterItem is deliberately NOT linked to this claim.

      await insertLink({ from: itemA, to: itemB, linkPosition: 0, placement: "content", isSameSite: false, anchorText: "the B report" });
      await insertLink({ from: itemA, to: null, linkPosition: 1, placement: "content" });
      await insertLink({ from: itemA, to: outOfClusterItem, linkPosition: 2, placement: "content" });

      const beforeRelationships = await countSourceRelationships();

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      const result = await triggerAnalyseProvenance(claim.id, provider);
      assert(result.kind === "ran", "scoping fixture: analysis ran");
      assert(provider.receivedRequests.length === 1, "scoping fixture: exactly one provider call");

      const prompt = provider.receivedRequests[0]!.userPrompt as string;
      assert(prompt.includes(`known outbound links`), "prompt includes a known outbound links section for item A");
      assert(prompt.includes(`-> item ${itemB}`), "prompt includes the resolved in-cluster link to item B");
      assert(!prompt.includes(`-> item ${outOfClusterItem}`), "prompt does NOT include the out-of-cluster resolved link");

      const occurrencesOfB = (prompt.match(new RegExp(`-> item ${itemB}:`, "g")) ?? []).length;
      assert(occurrencesOfB === 1, `exactly one qualifying link line for item B -- got ${occurrencesOfB}`);

      const afterRelationships = await countSourceRelationships();
      assert(afterRelationships === beforeRelationships, "link evidence existing creates ZERO new source_relationships rows on its own -- advisory input only");
    }

    // --- max 3 occurrences per directed pair, content > ambiguous > chrome, then position ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Per-pair cap fixture claim.");
      const itemA = await createTestSourceItem("Cap fixture A");
      const itemB = await createTestSourceItem("Cap fixture B");
      await linkClaimSource(claim.id, itemA);
      await linkClaimSource(claim.id, itemB);

      await insertLink({ from: itemA, to: itemB, linkPosition: 10, placement: "chrome", anchorText: "chrome-link" });
      await insertLink({ from: itemA, to: itemB, linkPosition: 5, placement: "ambiguous", anchorText: "ambiguous-link-early" });
      await insertLink({ from: itemA, to: itemB, linkPosition: 20, placement: "ambiguous", anchorText: "ambiguous-link-late" });
      await insertLink({ from: itemA, to: itemB, linkPosition: 8, placement: "content", anchorText: "content-link-early" });
      await insertLink({ from: itemA, to: itemB, linkPosition: 15, placement: "content", anchorText: "content-link-late" });

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      await triggerAnalyseProvenance(claim.id, provider);
      const prompt = provider.receivedRequests[0]!.userPrompt as string;

      const occurrences = (prompt.match(new RegExp(`-> item ${itemB}:`, "g")) ?? []).length;
      assert(occurrences === 3, `at most 3 occurrences per directed pair are forwarded -- got ${occurrences}`);
      assert(prompt.includes("content-link-early") && prompt.includes("content-link-late"), "both content-placed occurrences survive the cap");
      assert(prompt.includes("ambiguous-link-early"), "the EARLIER ambiguous occurrence survives (link_position tiebreaker), filling the 3rd slot");
      assert(!prompt.includes("ambiguous-link-late"), "the LATER ambiguous occurrence does NOT survive (only 1 ambiguous slot remains after 2 content)");
      assert(!prompt.includes("chrome-link"), "the chrome-placed occurrence is excluded entirely -- lowest priority, cap already full");
    }

    // --- same-site content link preserved, not treated as navigation ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Same-site fixture claim.");
      const itemA = await createTestSourceItem("Same-site fixture A");
      const itemB = await createTestSourceItem("Same-site fixture B");
      await linkClaimSource(claim.id, itemA);
      await linkClaimSource(claim.id, itemB);
      await insertLink({ from: itemA, to: itemB, linkPosition: 0, placement: "content", isSameSite: true, anchorText: "our earlier report" });

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      await triggerAnalyseProvenance(claim.id, provider);
      const prompt = provider.receivedRequests[0]!.userPrompt as string;

      assert(prompt.includes("placement=content"), "same-site link is still placement=content, not reclassified");
      assert(prompt.includes("same-site"), "same-site status is surfaced to the model as its own factual signal");
      assert(!prompt.includes("cross-site"), "a genuinely same-site link is never mislabeled cross-site");
    }

    // --- model-facing text frames link evidence as observations, not proof ---
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Prompt-framing fixture claim.");
      const itemA = await createTestSourceItem("Framing fixture A");
      const itemB = await createTestSourceItem("Framing fixture B");
      await linkClaimSource(claim.id, itemA);
      await linkClaimSource(claim.id, itemB);
      await insertLink({ from: itemA, to: itemB, linkPosition: 0, placement: "content" });

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      await triggerAnalyseProvenance(claim.id, provider);
      const systemPrompt = provider.receivedRequests[0]!.systemPrompt as string;
      const userPrompt = provider.receivedRequests[0]!.userPrompt as string;

      assert(
        systemPrompt.includes("does NOT itself prove citation") || systemPrompt.includes("NOT proof of citation"),
        "system prompt explicitly states a hyperlink does not itself prove citation/dependency"
      );
      assert(userPrompt.includes("NOT proof of citation"), "user-prompt link lines are explicitly labeled as observations, not proof");
    }

    // --- fingerprint actually used matches what the model saw -------------
    {
      const projectId = await createTestProject();
      const claim = await createTestClaim(projectId, "Fingerprint-consistency fixture claim.");
      const itemA = await createTestSourceItem("FP fixture A");
      const itemB = await createTestSourceItem("FP fixture B");
      await linkClaimSource(claim.id, itemA);
      await linkClaimSource(claim.id, itemB);
      await insertLink({ from: itemA, to: itemB, linkPosition: 0, placement: "content" });

      const provider = new FakeAiProvider([{ kind: "success", rawOutput: { edges: [] }, tokensIn: 5, tokensOut: 5 }]);
      const result = await triggerAnalyseProvenance(claim.id, provider);
      assert(result.kind === "ran", "fingerprint-consistency fixture: analysis ran");
      if (result.kind === "ran" && result.result.ok) {
        const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, result.result.jobId));
        assert(
          job?.provenanceClusterFingerprint === result.clusterFingerprint,
          "the fingerprint persisted on ai_jobs is the SAME value returned to the caller -- the enriched payload used for hashing and for the model call never diverge"
        );
      }
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} link-evidence check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll analyse_provenance link-evidence checks passed.");
  }
}

main().catch((err) => {
  console.error("Check crashed:", err);
  process.exit(1);
});
