-- =============================================================================
-- Migration 0003: claim slugs
--
-- Additive only. slug is a cosmetic/SEO identifier; the numeric id remains
-- the real identifier used by every FK and internal lookup. Routes resolve
-- by leading id (/claims/{id}-{slug}) so editing a slug later never breaks
-- an existing link.
-- =============================================================================

ALTER TABLE "claims" ADD COLUMN "slug" varchar(220);

-- Backfill: derive a slug from the existing statement for any pre-existing
-- rows (defensive; the seed script will supply real slugs going forward).
UPDATE "claims"
SET "slug" = lower(regexp_replace(regexp_replace(statement, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'))
WHERE "slug" IS NULL;

-- Disambiguate any accidental duplicates from the mechanical backfill by
-- suffixing the row id -- cheap and guaranteed unique.
UPDATE "claims" c
SET "slug" = c.slug || '-' || c.id
WHERE EXISTS (
  SELECT 1 FROM "claims" c2
  WHERE c2.slug = c.slug AND c2.id <> c.id
);

ALTER TABLE "claims" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "claims_slug_unique" ON "claims" ("slug");
