-- =============================================================================
-- Migration 0001: Evidence many-to-many + source taxonomy as lookup tables
--
-- Two independent changes bundled here because both were approved together
-- as pre-Phase-2 schema adjustments:
--
--   A. evidence.claim_id removed; replaced with a claim_evidence join table,
--      so evidence can exist unlinked (post-extraction, pre-review) and can
--      support/contradict more than one claim.
--   B. source_type / source_item_type converted from Postgres ENUMs to
--      lookup tables, so new categories are a data insert, not a schema
--      migration. investigation_status and development_outcome remain
--      ENUMs deliberately -- they are small, tightly controlled domain
--      states that define core business logic, not open-ended taxonomy.
--
-- Written to be safe against pre-existing data (UPDATE-before-DROP,
-- backfill via slug match) even though the current environment will apply
-- this to a freshly wiped database.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1. Source taxonomy lookup tables
-- ---------------------------------------------------------------------------

CREATE TABLE "source_types" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" varchar(64) NOT NULL,
  "label" varchar(200) NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_types_slug_unique" UNIQUE("slug")
);

CREATE TABLE "source_item_types" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" varchar(64) NOT NULL,
  "label" varchar(200) NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_item_types_slug_unique" UNIQUE("slug")
);

-- Seed the taxonomy with the original fixed values plus the additional
-- categories anticipated for future ingestion. This is ordinary reference
-- data, not a schema change, which is exactly the point of this migration.
INSERT INTO "source_types" (slug, label) VALUES
  ('news_outlet', 'News Outlet'),
  ('official_developer', 'Official Developer'),
  ('official_publisher', 'Official Publisher'),
  ('youtube_channel', 'YouTube Channel'),
  ('reddit_account', 'Reddit Account'),
  ('forum_account', 'Forum Account'),
  ('social_media_account', 'Social Media Account'),
  ('podcast', 'Podcast'),
  ('livestreamer', 'Livestreamer / Streaming Channel'),
  ('investor_relations', 'Investor Relations / Corporate'),
  ('community_organizer', 'Discord / Community Server'),
  ('unknown', 'Unknown');

INSERT INTO "source_item_types" (slug, label) VALUES
  ('article', 'Article'),
  ('reddit_post', 'Reddit Post'),
  ('reddit_comment', 'Reddit Comment'),
  ('forum_post', 'Forum Post'),
  ('video', 'Video'),
  ('social_post', 'Social Media Post'),
  ('official_statement', 'Official Statement'),
  ('press_release', 'Press Release'),
  ('interview_transcript', 'Interview Transcript'),
  ('podcast_episode', 'Podcast Episode'),
  ('livestream', 'Livestream'),
  ('trailer', 'Trailer'),
  ('screenshot', 'Screenshot'),
  ('archived_page', 'Archived Page'),
  ('deleted_post', 'Deleted Post (archived elsewhere)'),
  ('investor_document', 'Investor Document'),
  ('earnings_call', 'Earnings Call'),
  ('store_listing', 'Store Listing'),
  ('community_post', 'Discord / Community Post'),
  ('other', 'Other');

-- ---------------------------------------------------------------------------
-- A2. sources.source_type (enum) -> sources.source_type_id (FK)
-- ---------------------------------------------------------------------------

ALTER TABLE "sources" ADD COLUMN "source_type_id" integer;

UPDATE "sources" s
SET "source_type_id" = st.id
FROM "source_types" st
WHERE st.slug = s.source_type::text;

-- Anything that didn't match an existing slug (shouldn't happen from the
-- fixed enum, but defensive) falls back to 'unknown' rather than blocking
-- the migration.
UPDATE "sources" s
SET "source_type_id" = (SELECT id FROM "source_types" WHERE slug = 'unknown')
WHERE s."source_type_id" IS NULL;

ALTER TABLE "sources" ALTER COLUMN "source_type_id" SET NOT NULL;
ALTER TABLE "sources" ADD CONSTRAINT "sources_source_type_id_source_types_id_fk"
  FOREIGN KEY ("source_type_id") REFERENCES "source_types"("id");
ALTER TABLE "sources" DROP COLUMN "source_type";

-- ---------------------------------------------------------------------------
-- A3. source_items.item_type (enum) -> source_items.item_type_id (FK)
-- ---------------------------------------------------------------------------

ALTER TABLE "source_items" ADD COLUMN "item_type_id" integer;

UPDATE "source_items" si
SET "item_type_id" = sit.id
FROM "source_item_types" sit
WHERE sit.slug = si.item_type::text;

UPDATE "source_items" si
SET "item_type_id" = (SELECT id FROM "source_item_types" WHERE slug = 'other')
WHERE si."item_type_id" IS NULL;

ALTER TABLE "source_items" ALTER COLUMN "item_type_id" SET NOT NULL;
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_item_type_id_source_item_types_id_fk"
  FOREIGN KEY ("item_type_id") REFERENCES "source_item_types"("id");
ALTER TABLE "source_items" DROP COLUMN "item_type";

-- Now safe to drop the enum types themselves.
DROP TYPE "source_type";
DROP TYPE "source_item_type";

-- ---------------------------------------------------------------------------
-- B1. evidence.claim_id -> claim_evidence (many-to-many)
-- ---------------------------------------------------------------------------

CREATE TABLE "claim_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "claim_id" integer NOT NULL,
  "evidence_id" integer NOT NULL,
  "stance" "claim_source_stance" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk"
  FOREIGN KEY ("claim_id") REFERENCES "claims"("id");
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_id_evidence_id_fk"
  FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id");
CREATE UNIQUE INDEX "claim_evidence_unique" ON "claim_evidence" ("claim_id", "evidence_id");

-- Backfill: any existing evidence.claim_id link becomes a claim_evidence
-- row. Default stance 'supports' -- the prior model had no stance concept
-- for evidence, so this is the only defensible default on migration; it
-- is a one-time backfill assumption, not a going-forward default.
INSERT INTO "claim_evidence" ("claim_id", "evidence_id", "stance")
SELECT "claim_id", "id", 'supports'
FROM "evidence"
WHERE "claim_id" IS NOT NULL;

ALTER TABLE "evidence" DROP COLUMN "claim_id";
