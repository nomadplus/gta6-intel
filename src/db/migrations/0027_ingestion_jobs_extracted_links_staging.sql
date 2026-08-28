-- =============================================================================
-- Migration 0027: staging column for extracted links, mirroring exactly how
-- migration 0009 added extracted_title/extracted_excerpt/etc as transient
-- review-flow columns on ingestion_jobs. This column holds the SAME bounded,
-- already-filtered, already-truncated, already-priority-capped (max
-- MAX_EXTRACTED_LINKS_PER_JOB = 200) link array that durable source_item_links
-- rows are created from at confirmation time -- it exists only because a
-- source_items.id (the FK source_item_links.from_source_item_id needs) does
-- not exist yet at the point a job reaches needs_review/
-- ready_for_confirmation. It is consumed and superseded by real
-- source_item_links rows the moment finalizeIngestionConfirmation creates
-- the source_items row; an unconfirmed job's staged links are simply never
-- promoted and are harmless, bounded dead weight on that row (same as an
-- abandoned job's extracted_title today).
--
-- No new bound is enforced at the SQL level here: by the time application
-- code writes this column, every bound (row count, per-field length) has
-- ALREADY been applied by the extractor -- this column is never a raw,
-- uncapped dump that gets filtered later.
-- =============================================================================

ALTER TABLE "ingestion_jobs"
  ADD COLUMN "extracted_links_staging" jsonb;
