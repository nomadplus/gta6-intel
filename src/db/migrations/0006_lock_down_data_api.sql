-- =============================================================================
-- Lock down Supabase's Data API (PostgREST) access to the application schema.
--
-- Context (see docs/architecture.md "Data API lockdown" for the full record):
-- a post-cleanup security audit found that every table in `public` had Row
-- Level Security disabled AND full CRUD grants (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE) to Supabase's built-in `anon` and `authenticated` roles -- the
-- roles Supabase's auto-generated REST API (PostgREST) uses, and which are
-- reachable using the publishable/anon key that is necessarily public (it
-- ships to the browser for Supabase Auth to work). This meant every table,
-- including admin_users, admin_audit_log, and both append-only status
-- history ledgers, was potentially directly readable and writable through a
-- path that completely bypasses the application, its role separation
-- (app_role/admin_role), its authentication, and its append-only
-- protections.
--
-- The application never uses this path: it connects via direct Postgres
-- connections as app_role/admin_role, and the only Supabase JS client usage
-- anywhere in the codebase is `supabase.auth.*` calls (Supabase Auth lives
-- in the separate `auth` schema and is unaffected by anything in this
-- migration). Given that, the safest model is deny-by-default rather than
-- writing permissive RLS policies to replicate what app_role/admin_role
-- already do correctly at the connection level.
--
-- This migration:
--   1. Revokes schema-level USAGE and all object-level privileges from
--      anon/authenticated on every table, view, sequence, and function in
--      `public` -- the primary control.
--   2. Sets default privileges so future objects created in `public` don't
--      automatically re-grant anon/authenticated anything either.
--   3. Enables Row Level Security on every table with zero policies -- a
--      second, independent control: even if a future migration accidentally
--      re-grants a privilege, RLS still blocks every row for any role that
--      isn't the table owner and doesn't have BYPASSRLS.
--   4. Grants BYPASSRLS to app_role and admin_role specifically so RLS is
--      completely transparent to them -- their existing, already-correct
--      grant-based scoping (app_role: SELECT-only; admin_role: SELECT/
--      INSERT but never UPDATE/DELETE on the two history ledgers) continues
--      to be the only thing that matters for those two roles, exactly as
--      designed in migrations 0002 and 0004. This is deliberately simpler
--      than authoring per-table RLS policies for app_role/admin_role, which
--      would just be a more verbose, more error-prone way of expressing
--      privileges those roles already have correctly via GRANT.
--
-- Table ownership is unaffected (all tables remain owned by the role that
-- ran the migrations, which already bypasses RLS as a Postgres primitive),
-- so migrations themselves are unaffected by this change.
-- =============================================================================

REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_item_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_investigation_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_development_outcome_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investigation_transition_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.development_transition_evidence ENABLE ROW LEVEL SECURITY;

-- claim_status_timeline is a plain view (UNION ALL over the two history
-- ledgers, see migration 0002) -- views don't have their own RLS switch,
-- they run with the querying role's privileges against the underlying
-- tables, so the REVOKE above plus RLS on the two ledgers it reads already
-- covers it. No ALTER VIEW step is needed or exists for RLS.

ALTER ROLE app_role BYPASSRLS;
ALTER ROLE admin_role BYPASSRLS;
