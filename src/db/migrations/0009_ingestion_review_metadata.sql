-- =============================================================================
-- Migration 0009: Phase 4 PR 7 -- persisted ingestion review metadata
--
-- Closes the gap flagged during PR 4/5 planning (see
-- src/db/mutations/ingestion.ts and src/lib/ingestion/reviewPayloadSigning.ts):
-- a 'needs_review' (or 'ready_for_confirmation') pipeline outcome's extracted
-- metadata previously existed ONLY as an in-memory value for the single
-- request/response that produced it, signed into a short-lived token for one
-- immediate confirm click. If the admin didn't act in that same request, the
-- job was stuck at 'needs_review' forever with no way to recover the data
-- needed to confirm it -- a direct conflict with the project's standing rule
-- that ingestion work must be recoverable, not silently lost.
--
-- These columns let the pipeline persist that metadata server-side, so a
-- later admin session (via /admin/ingest/history) can re-derive a fresh,
-- signed review token from data the server itself already wrote, instead of
-- requiring the original ephemeral token or a re-fetch of the URL.
--
-- All nullable, all additive -- no existing column, constraint, or enum is
-- touched. Column shapes deliberately mirror the equivalent source_items
-- columns (title/author/publishedAt/excerpt/canonicalUrl/rawContentHash)
-- exactly, since this is the same data, just captured one step earlier in
-- the pipeline and not yet promoted into a source_items row.
-- =============================================================================

ALTER TABLE "ingestion_jobs" ADD COLUMN "retrieved_url" text;
ALTER TABLE "ingestion_jobs" ADD COLUMN "canonical_url" text;
ALTER TABLE "ingestion_jobs" ADD COLUMN "raw_content_hash" varchar(64);
ALTER TABLE "ingestion_jobs" ADD COLUMN "extracted_title" text;
ALTER TABLE "ingestion_jobs" ADD COLUMN "extracted_author" varchar(300);
ALTER TABLE "ingestion_jobs" ADD COLUMN "extracted_published_at" timestamp with time zone;
ALTER TABLE "ingestion_jobs" ADD COLUMN "extracted_excerpt" text;

-- No grant/RLS changes needed -- these are new columns on an existing table
-- (ingestion_jobs), which already has anon/authenticated revoked and RLS
-- enabled with admin_role-only grants from migration 0007. New columns on an
-- already-locked-down table inherit that same access; there is no per-column
-- grant surface in Postgres to separately secure.
