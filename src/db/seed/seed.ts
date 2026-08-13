/**
 * Phase 1 hand-seeded test data.
 *
 * This is NOT synthetic filler — each claim below was chosen to stress a
 * specific architectural guarantee. See the comment above each block for
 * which requirement it proves out.
 *
 * Run with: DATABASE_URL=... npx tsx src/db/seed/seed.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://migrator_role:migrator_dev_password@localhost:5432/gta6_intel",
});
const db = drizzle(pool, { schema });

async function main() {
  console.log("Seeding gta6_intel...");

  // ---------------------------------------------------------------------
  // Foundational rows
  // ---------------------------------------------------------------------
  const [project] = await db
    .insert(schema.projects)
    .values({ slug: "gta-vi", name: "Grand Theft Auto VI" })
    .returning();

  const [admin] = await db
    .insert(schema.adminUsers)
    .values({
      displayName: "Test Owner",
      email: "owner@example.test",
      role: "owner",
      // Fixed placeholder standing in for a real Supabase Auth user id.
      // Phase 3's injected-session test harness uses this same value so
      // requireAdmin() resolves to this seeded row without a live login.
      authUserId: "test-owner-0000-0000-0000-000000000001",
    })
    .returning();

  const [editorUser] = await db
    .insert(schema.adminUsers)
    .values({
      displayName: "Test Editor",
      email: "editor@example.test",
      role: "editor",
      authUserId: "test-editor-0000-0000-0000-000000000002",
    })
    .returning();

  const [readOnlyUser] = await db
    .insert(schema.adminUsers)
    .values({
      displayName: "Test Read-Only Analyst",
      email: "analyst@example.test",
      role: "read_only_analyst",
      authUserId: "test-analyst-0000-0000-0000-000000000003",
    })
    .returning();

  const [topicMap, topicProtagonists, topicRelease] = await db
    .insert(schema.topics)
    .values([
      { projectId: project.id, slug: "map", name: "Map & Setting" },
      { projectId: project.id, slug: "protagonists", name: "Protagonists" },
      { projectId: project.id, slug: "release-date", name: "Release Date" },
    ])
    .returning();

  // Source taxonomy lookups (seeded by migration 0001; fetched here by slug
  // rather than hardcoding IDs, since the point of the lookup-table design
  // is that these are just data).
  const allSourceTypes = await db.select().from(schema.sourceTypes);
  const allSourceItemTypes = await db.select().from(schema.sourceItemTypes);
  const sourceTypeId = (slug: string) => {
    const row = allSourceTypes.find((r) => r.slug === slug);
    if (!row) throw new Error(`Unknown source_type slug: ${slug}`);
    return row.id;
  };
  const itemTypeId = (slug: string) => {
    const row = allSourceItemTypes.find((r) => r.slug === slug);
    if (!row) throw new Error(`Unknown source_item_type slug: ${slug}`);
    return row.id;
  };

  // Sources: a Reddit leaker, a gaming site that reported the leak, a
  // second gaming site that cited the first (NOT independent), and
  // Rockstar's own official channel.
  const [srcReddit, srcSiteA, srcSiteB, srcRockstar] = await db
    .insert(schema.sources)
    .values([
      { name: "u/gta6_insider_2021", sourceTypeId: sourceTypeId("reddit_account") },
      { name: "Gaming Site A", sourceTypeId: sourceTypeId("news_outlet") },
      { name: "Gaming Site B", sourceTypeId: sourceTypeId("news_outlet") },
      { name: "Rockstar Games (official)", sourceTypeId: sourceTypeId("official_developer") },
    ])
    .returning();

  const [itemReddit, itemSiteA, itemSiteB, itemRockstarTrailer, itemRockstarNewswire] =
    await db
      .insert(schema.sourceItems)
      .values([
        {
          sourceId: srcReddit.id,
          itemTypeId: itemTypeId("reddit_post"),
          url: "https://reddit.com/r/GTA6/example_leak_post",
          title: "Heard from a friend at Rockstar - Vice City confirmed, two leads",
          publishedAt: new Date("2021-06-17T00:00:00Z"),
          excerpt: "Taking place in and around Vice City, with two protagonists.",
        },
        {
          sourceId: srcSiteA.id,
          itemTypeId: itemTypeId("article"),
          url: "https://gamingsitea.example/gta6-leak-report",
          title: "Reddit leak claims GTA VI set in Vice City with dual protagonists",
          publishedAt: new Date("2021-06-18T00:00:00Z"),
          excerpt: "A widely-shared Reddit post claims the game returns to Vice City.",
        },
        {
          sourceId: srcSiteB.id,
          itemTypeId: itemTypeId("article"),
          url: "https://gamingsiteb.example/more-on-the-gta6-leak",
          title: "GTA VI rumours heat up following viral report",
          publishedAt: new Date("2021-06-19T00:00:00Z"),
          excerpt: "As reported by Gaming Site A, the leak points to Vice City.",
        },
        {
          sourceId: srcRockstar.id,
          itemTypeId: itemTypeId("trailer"),
          url: "https://youtube.com/rockstar-trailer-1",
          title: "Grand Theft Auto VI Trailer 1",
          publishedAt: new Date("2023-12-05T00:00:00Z"),
          excerpt: "Welcome back to Vice City.",
        },
        {
          sourceId: srcRockstar.id,
          itemTypeId: itemTypeId("press_release"),
          url: "https://rockstargames.com/newswire/example-statement",
          title: "A note on GTA VI's development",
          publishedAt: new Date("2022-09-19T00:00:00Z"),
          excerpt: "We are extremely disappointed that details of our next game were shared.",
        },
      ])
      .returning();

  // Source relationship: Site B's article is a DERIVATIVE/CITATION of Site
  // A's article, not an independent confirmation of the Reddit leak.
  await db.insert(schema.sourceRelationships).values([
    {
      sourceItemIdA: itemSiteB.id,
      sourceItemIdB: itemSiteA.id,
      relationshipType: "citation",
      confidence: "0.900",
      evidenceNote: "Site B article explicitly attributes its claim to Site A's reporting.",
    },
    {
      sourceItemIdA: itemSiteA.id,
      sourceItemIdB: itemReddit.id,
      relationshipType: "citation",
      confidence: "0.950",
      evidenceNote: "Site A explicitly names and links the Reddit post as its source.",
    },
  ]);

  // =======================================================================
  // CASE 1: Multi-step investigation-status progression on one claim,
  // culminating in official confirmation. Proves append-only history +
  // auto-synced current-status pointer across several transitions.
  // =======================================================================
  const [claimViceCity] = await db
    .insert(schema.claims)
    .values({
      projectId: project.id,
      slug: "gta-vi-set-in-vice-city",
      statement: "GTA VI is set in and around a fictionalized version of Miami called Vice City.",
      informationType: "leak",
      firstReportedAt: new Date("2021-06-17T00:00:00Z"),
    })
    .returning();

  await db.insert(schema.claimTopics).values([
    { claimId: claimViceCity.id, topicId: topicMap.id },
  ]);

  await db.insert(schema.claimSources).values([
    { claimId: claimViceCity.id, sourceItemId: itemReddit.id, stance: "supports" },
    { claimId: claimViceCity.id, sourceItemId: itemSiteA.id, stance: "supports" },
    { claimId: claimViceCity.id, sourceItemId: itemSiteB.id, stance: "supports" },
    { claimId: claimViceCity.id, sourceItemId: itemRockstarTrailer.id, stance: "supports" },
  ]);

  // Transition 1: initial unverified leak
  await db.insert(schema.claimInvestigationStatusHistory).values({
    claimId: claimViceCity.id,
    previousStatus: null,
    newStatus: "unverified",
    changedAt: new Date("2021-06-17T00:00:00Z"),
    reason: "Initial report from a single Reddit source with no corroboration.",
    confidence: "0.300",
    initiatedBy: "human",
  });

  // Transition 2: corroborated once a second, independent-seeming outlet
  // picked it up (this is deliberately the SITE A pickup, which genuinely
  // is a separate publication choosing to report it, not a chain link)
  await db.insert(schema.claimInvestigationStatusHistory).values({
    claimId: claimViceCity.id,
    previousStatus: "unverified",
    newStatus: "corroborated",
    changedAt: new Date("2021-06-18T00:00:00Z"),
    reason: "Picked up and reported independently by Gaming Site A.",
    confidence: "0.550",
    initiatedBy: "human",
  });

  // Transition 3: officially confirmed by the Trailer 1 release
  await db.insert(schema.claimInvestigationStatusHistory).values({
    claimId: claimViceCity.id,
    previousStatus: "corroborated",
    newStatus: "confirmed",
    changedAt: new Date("2023-12-05T00:00:00Z"),
    reason: "Rockstar's official Trailer 1 explicitly confirms the Vice City setting.",
    confidence: "1.000",
    initiatedBy: "human",
  });

  await db.insert(schema.claimDevelopmentOutcomeHistory).values({
    claimId: claimViceCity.id,
    previousOutcome: null,
    newOutcome: "in_final_game",
    changedAt: new Date("2023-12-05T00:00:00Z"),
    reason: "Confirmed present via official trailer; no indication of change since.",
    confidence: "1.000",
    initiatedBy: "human",
  });

  // =======================================================================
  // CASE 2: Accurate-when-reported, later cut. Proves the two-axis model
  // can hold Confirmed (investigation) + Cut (development outcome)
  // simultaneously without contradiction.
  // =======================================================================
  const [claimWeatherDamage] = await db
    .insert(schema.claims)
    .values({
      projectId: project.id,
      slug: "persistent-weather-damage-system",
      statement:
        "GTA VI includes a dynamic weather system that causes persistent, long-term damage to the game world's infrastructure.",
      informationType: "leak",
      firstReportedAt: new Date("2022-09-01T00:00:00Z"),
    })
    .returning();

  const [evidenceWeatherFootage] = await db
    .insert(schema.evidence)
    .values({
      sourceItemId: itemRockstarNewswire.id,
      description:
        "Leaked internal development footage (referenced, not hosted) reportedly showed persistent flood damage to a coastal district after a storm event.",
      evidenceType: "leaked_footage_description",
      addedBy: "human",
    })
    .returning();

  // Linked to the claim it supports via the many-to-many join table
  // (evidence no longer carries a direct claim_id).
  await db.insert(schema.claimEvidence).values({
    claimId: claimWeatherDamage.id,
    evidenceId: evidenceWeatherFootage.id,
    stance: "supports",
  });

  await db.insert(schema.claimInvestigationStatusHistory).values([
    {
      claimId: claimWeatherDamage.id,
      previousStatus: null,
      newStatus: "unverified",
      changedAt: new Date("2022-09-01T00:00:00Z"),
      reason: "Single leak source describing internal build footage.",
      confidence: "0.400",
      initiatedBy: "human",
    },
    {
      claimId: claimWeatherDamage.id,
      previousStatus: "unverified",
      newStatus: "confirmed",
      changedAt: new Date("2022-09-25T00:00:00Z"),
      reason:
        "Multiple independent leaked build clips from separate leak sources show the same persistent damage mechanic, consistent enough in detail to treat the underlying feature's existence at that time as confirmed.",
      confidence: "0.900",
      initiatedBy: "human",
    },
  ]);

  // Development outcome later diverges from investigation status — this is
  // the crux case for Section 4 of the project brief.
  await db.insert(schema.claimDevelopmentOutcomeHistory).values([
    {
      claimId: claimWeatherDamage.id,
      previousOutcome: null,
      newOutcome: "reflected_in_development",
      changedAt: new Date("2022-09-25T00:00:00Z"),
      reason: "Feature genuinely existed in an internal build at the time of leak.",
      confidence: "0.900",
      initiatedBy: "human",
    },
    {
      claimId: claimWeatherDamage.id,
      previousOutcome: "reflected_in_development",
      newOutcome: "cut",
      changedAt: new Date("2024-03-10T00:00:00Z"),
      reason:
        "Not present in Trailer 2 or subsequent official gameplay material; a former QA contractor's public account states the persistent-damage system was simplified for performance reasons well before release.",
      confidence: "0.700",
      initiatedBy: "human",
    },
  ]);

  // =======================================================================
  // CASE 3: Disproven claim (the "rumour graveyard" case).
  // =======================================================================
  const [claimThreeCity] = await db
    .insert(schema.claims)
    .values({
      projectId: project.id,
      slug: "three-separate-cities-at-launch",
      statement: "GTA VI spans three fully separate cities at launch, not one contiguous state.",
      informationType: "speculation",
      firstReportedAt: new Date("2021-07-02T00:00:00Z"),
    })
    .returning();

  await db.insert(schema.claimInvestigationStatusHistory).values([
    {
      claimId: claimThreeCity.id,
      previousStatus: null,
      newStatus: "unverified",
      changedAt: new Date("2021-07-02T00:00:00Z"),
      reason: "Speculative forum theory extrapolating from an unrelated leak.",
      confidence: "0.150",
      initiatedBy: "human",
    },
    {
      claimId: claimThreeCity.id,
      previousStatus: "unverified",
      newStatus: "disproven",
      changedAt: new Date("2023-12-05T00:00:00Z"),
      reason:
        "Trailer 1 and all subsequent official material depict a single contiguous open-world state (Leonida), not three separate cities.",
      confidence: "0.950",
      initiatedBy: "human",
    },
  ]);

  await db.insert(schema.claimDevelopmentOutcomeHistory).values({
    claimId: claimThreeCity.id,
    previousOutcome: null,
    newOutcome: "not_applicable",
    changedAt: new Date("2023-12-05T00:00:00Z"),
    reason:
      "Claim describes a world-structure prediction that was never accurate, not a feature that was cut during development.",
    confidence: "0.900",
    initiatedBy: "human",
  });

  // =======================================================================
  // CASE 4: AI-assisted pipeline, INCLUDING a rejected AI proposal, proving
  // rejected proposals are fully preserved in ai_results/admin_decisions
  // but never produce a status_history row or move the current-status
  // pointer.
  // =======================================================================
  const [claimFemaleProtagonist] = await db
    .insert(schema.claims)
    .values({
      projectId: project.id,
      slug: "female-protagonist-among-two-leads",
      statement: "GTA VI features a female protagonist as one of its two leads.",
      informationType: "leak",
      firstReportedAt: new Date("2022-09-01T00:00:00Z"),
    })
    .returning();

  await db.insert(schema.claimTopics).values([
    { claimId: claimFemaleProtagonist.id, topicId: topicProtagonists.id },
  ]);

  await db.insert(schema.claimInvestigationStatusHistory).values({
    claimId: claimFemaleProtagonist.id,
    previousStatus: null,
    newStatus: "corroborated",
    changedAt: new Date("2022-09-25T00:00:00Z"),
    reason: "Multiple leaked build clips consistently show a playable female character.",
    confidence: "0.750",
    initiatedBy: "human",
  });

  // AI job + result recommending an escalation to "confirmed" BEFORE any
  // official material existed -- an overreach an admin correctly rejects.
  const [aiJob1] = await db
    .insert(schema.aiJobs)
    .values({
      operation: "recommend_status",
      provider: "anthropic",
      model: "claude-sonnet-5",
      status: "succeeded",
      inputRef: `claim:${claimFemaleProtagonist.id}`,
      tokensIn: 1840,
      tokensOut: 260,
      costEstimateUsd: "0.006280",
      startedAt: new Date("2022-10-01T12:00:00Z"),
      completedAt: new Date("2022-10-01T12:00:05Z"),
    })
    .returning();

  const [aiResult1] = await db
    .insert(schema.aiResults)
    .values({
      aiJobId: aiJob1.id,
      claimId: claimFemaleProtagonist.id,
      structuredOutput: {
        recommendedInvestigationStatus: "confirmed",
        rationale:
          "Volume and consistency of leaked build footage across multiple independent leakers is high enough to treat as confirmed.",
      },
      confidence: "0.820",
      reasoning:
        "Multiple leak sources independently show the same character model in playable contexts, which the model weighted as strong evidence.",
    })
    .returning();

  // Admin REJECTS this recommendation: leaked build footage, however
  // consistent, is not the same evidentiary class as official confirmation,
  // and the two-tier status model reserves "confirmed" for that bar.
  const [adminDecision1] = await db
    .insert(schema.adminDecisions)
    .values({
      aiResultId: aiResult1.id,
      adminUserId: admin.id,
      action: "reject",
      notes:
        "Leaked footage, even from multiple sources, is corroboration, not confirmation. Reserve 'confirmed' for official Rockstar/Take-Two statements or material. Recommendation rejected; status remains corroborated.",
    })
    .returning();

  // Deliberately: NO INSERT into claimInvestigationStatusHistory here.
  // This is the entire point of the case.

  // Later, official confirmation actually arrives via the trailer -- this
  // time via an AI proposal that gets APPROVED, showing the accepted path
  // for comparison.
  const [aiJob2] = await db
    .insert(schema.aiJobs)
    .values({
      operation: "recommend_status",
      provider: "anthropic",
      model: "claude-sonnet-5",
      status: "succeeded",
      inputRef: `claim:${claimFemaleProtagonist.id}`,
      tokensIn: 2210,
      tokensOut: 310,
      costEstimateUsd: "0.008870",
      startedAt: new Date("2023-12-05T14:00:00Z"),
      completedAt: new Date("2023-12-05T14:00:06Z"),
    })
    .returning();

  const [aiResult2] = await db
    .insert(schema.aiResults)
    .values({
      aiJobId: aiJob2.id,
      claimId: claimFemaleProtagonist.id,
      structuredOutput: {
        recommendedInvestigationStatus: "confirmed",
        rationale: "Official Trailer 1 explicitly confirms a female lead protagonist (Lucia).",
      },
      confidence: "0.980",
      reasoning: "Direct official first-party material satisfies the confirmation bar.",
    })
    .returning();

  const [adminDecision2] = await db
    .insert(schema.adminDecisions)
    .values({
      aiResultId: aiResult2.id,
      adminUserId: admin.id,
      action: "approve",
      notes: "Agreed -- official trailer meets the confirmation bar.",
    })
    .returning();

  // THIS insert is the one that actually happened -- linked to the
  // approved AI result and the approving admin decision.
  await db.insert(schema.claimInvestigationStatusHistory).values({
    claimId: claimFemaleProtagonist.id,
    previousStatus: "corroborated",
    newStatus: "confirmed",
    changedAt: new Date("2023-12-05T14:00:06Z"),
    reason: aiResult2.reasoning!,
    confidence: "0.980",
    initiatedBy: "ai",
    aiResultId: aiResult2.id,
    adminDecisionId: adminDecision2.id,
  });

  // =======================================================================
  // CASE 5: Evidence lifecycle -- (a) evidence stored with NO claim link
  // yet (freshly extracted, awaiting review), and (b) one piece of
  // evidence reused across TWO different claims. Proves the many-to-many
  // model added in migration 0001.
  // =======================================================================

  // (a) Unlinked: a newly-extracted piece of evidence from a trailer that
  // hasn't been triaged/matched to any claim yet. Valid state -- not an
  // error, not a placeholder claim.
  const [evidenceUnlinked] = await db
    .insert(schema.evidence)
    .values({
      sourceItemId: itemRockstarTrailer.id,
      description:
        "Trailer 1 briefly shows a character resembling a second, older male protagonist alongside Lucia and Jason, not yet matched to an existing claim.",
      evidenceType: "frame_observation",
      addedBy: "ai",
    })
    .returning();
  // Deliberately: no claim_evidence row for evidenceUnlinked.id yet.

  // (b) Reused: the same Trailer 1 footage is evidence for BOTH the Vice
  // City setting claim and the female protagonist claim -- one clip,
  // two independent propositions it bears on.
  const [evidenceTrailerReused] = await db
    .insert(schema.evidence)
    .values({
      sourceItemId: itemRockstarTrailer.id,
      description:
        "Trailer 1 opening sequence establishes the Vice City skyline and introduces Lucia in a playable-context shot.",
      evidenceType: "frame_observation",
      addedBy: "human",
    })
    .returning();

  await db.insert(schema.claimEvidence).values([
    { claimId: claimViceCity.id, evidenceId: evidenceTrailerReused.id, stance: "supports" },
    {
      claimId: claimFemaleProtagonist.id,
      evidenceId: evidenceTrailerReused.id,
      stance: "supports",
    },
  ]);

  console.log("Seed complete.");
  console.log({
    project: project.id,
    claims: {
      viceCity: claimViceCity.id,
      weatherDamage: claimWeatherDamage.id,
      threeCity: claimThreeCity.id,
      femaleProtagonist: claimFemaleProtagonist.id,
    },
    rejectedAiResultId: aiResult1.id,
    rejectingAdminDecisionId: adminDecision1.id,
    unlinkedEvidenceId: evidenceUnlinked.id,
    reusedEvidenceId: evidenceTrailerReused.id,
    adminUsers: { owner: admin.id, editor: editorUser.id, readOnly: readOnlyUser.id },
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
