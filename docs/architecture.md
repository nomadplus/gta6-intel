# Architecture notes

Companion to the root `README.md`. This document covers the data model in
more detail, and keeps a record of the post-Phase-3 cleanup work
(migration history reconciliation, SEO base URL, credential removal) so
future changes don't rediscover the same issues from scratch.

---

## Data model detail

### Subject / topics

`projects` (the game — currently just `gta-vi`, structured so a future
`gta-vii` or other title is a data row, not a schema change) → `topics`
(freeform tagging, unique per project+slug).

### Sources and source items

`sources` (a publication/channel/person) → `source_items` (one specific
piece of content — an article, tweet, video). `source_type` and
`source_item_type` are **lookup tables, not enums**
(`source_types`/`source_item_types`), deliberately: these are open-ended,
expected to grow (podcast, livestream, trailer, screenshot,
archived_page, deleted_post, investor_document, ...), so a new category
is a data insert, not a migration. This is unlike `investigation_status`/
`development_outcome`, which are tight, deliberately-controlled enums
because they define core business logic.

`source_items.excerpt` is a short, legally-safe excerpt only — the
platform does not store full-article copies.

### Provenance: `source_relationships`

Directed relationships **between two source items**:
`original`, `independent_corroboration`, `citation`, `repetition`,
`aggregation`, `derivative`, `unknown`. This is the mechanism that
prevents "fifty articles repeating one leak" from being treated as fifty
independent confirmations — each of those forty-nine would be a
`repetition` or `citation` edge back to the one `original`. No symmetric
canonicalization here (unlike `claim_relationships` below) because
provenance is inherently directional — a `citation` always has a
from/to.

### Discovery / ingestion (Phase 4 PR 1 — schema only)

Three concepts that sound related but answer different questions, kept
deliberately separate at the schema level:

- **Discovery** — HOW a source item entered the system in the first
  place (`discovery_providers`: `manual`, `rss`, and later others;
  `ingestion_jobs`: one row per fetch/discovery attempt). This is a
  pipeline/operational concern with no epistemic weight of its own —
  finding something via RSS says nothing about whether it's true.
- **Provenance** — HOW a source item relates to *other reporting*
  (`source_relationships`, above). Orthogonal to discovery: an item found
  manually can be a `citation` of something an RSS feed discovered
  first, and vice versa. Provenance is what prevents citation chains from
  being counted as independent corroboration; discovery has no role in
  that judgment.
- **Truth** — whether a claim built from that item is actually
  well-evidenced (`claims.current_investigation_status` /
  `current_development_outcome`, decided via the two-axis model above,
  reviewed by an admin). Never inferred from how, or how many times,
  something was discovered.

`ingestion_jobs` tracks one ingestion/discovery *attempt*, not a source
item — a single URL can have several attempts (retry after
`fetch_failed`, a later re-check that finds it's since become
`paywalled`, etc.), and a successful one eventually produces a row in
`source_items` via the nullable `source_item_id` FK. `ingestion_status`
is a small, fixed enum (`queued`, `fetching`, `stored`, `duplicate`,
`needs_review`, `blocked_by_policy`, `robots_disallowed`,
`authentication_required`, `paywalled`, `unsupported`, `fetch_failed`,
`rate_limited`, `malformed`) — deliberately an ENUM rather than a lookup
table like `discovery_providers`, for the same reason
`investigation_status`/`development_outcome` are ENUMs: this is a
tightly controlled pipeline vocabulary that defines real logic, not an
open-ended taxonomy expected to grow casually.

`ingestion_jobs.created_at` (queue time) and `started_at` (actual fetch
attempt time) are deliberately separate columns — future per-domain rate
limiting needs real fetch-attempt timing, not queue timing. Neither
rate limiting nor any other pipeline logic is implemented yet; this PR
is schema only.

`source_items.normalized_url` is indexed but **deliberately not
unique** — publishers reuse URLs (a canonical URL's content can change
after publication), so "same normalized URL" can never mean "same item"
at the schema level. The planned duplicate-detection rule is: same URL +
same `raw_content_hash` (already existed, migration 0000) → `duplicate`;
same URL + different hash → `needs_review`. That comparison is future
application logic, not something this migration enforces — the schema
only adds the column and index it will need.

A related but unenforced rule, noted here because the schema was shaped
for it: if another `ingestion_jobs` row with the same `normalized_url`
is currently `queued` or `fetching` and was created within the previous
hour, future ingestion code should reuse that job rather than starting a
duplicate one. `ingestion_jobs_inflight_lookup_idx` — a partial index on
`(normalized_url, created_at)` `WHERE status IN ('queued', 'fetching')`
— exists to make that future query efficient; there is no uniqueness
constraint backing it, and the 1-hour window is application logic, kept
out of the index definition deliberately since it may change.

**Grants:** both new tables get zero grants for `app_role` — the public
website has no product need to see ingestion pipeline state
(`discovery_providers` is administrative reference data; `ingestion_jobs`
holds raw submitted URLs, fetch attempts, and failure reasons, none of
it published content). `admin_role` gets full `SELECT`/`INSERT`/
`UPDATE`/`DELETE` on both — neither is an append-only ledger like the
status-history tables, since a job's status legitimately moves through
its lifecycle in place. Per the standing rule below, migration 0007 also
explicitly revokes `anon`/`authenticated` privileges and enables RLS on
both new tables in the same migration that creates them, rather than
relying only on migration 0006's schema-wide defaults.

**Standing rule, in effect from migration 0007 onward:** every migration
that creates an application table must explicitly secure that table in
the same migration — explicit `REVOKE` from `anon`/`authenticated`,
explicit `ENABLE ROW LEVEL SECURITY`, explicit grants to
`app_role`/`admin_role`. Migration 0006's `ALTER DEFAULT PRIVILEGES`
statements are scoped to the role that ran the migration that set them;
Supabase's own default privileges for its `supabase_admin` role are a
separate mechanism that can independently re-grant `anon`/`authenticated`
access to objects created by a different creating role. Explicit
per-migration statements are the only thing that isn't contingent on
which role happens to execute a future migration.

### Claims

`claims.information_type`: `fact`, `official`, `report`, `leak`,
`rumour`, `speculation`, `prediction`, `interpretation` — set once at
claim creation, based on what the reporting actually was, and never
silently reclassified.

`claims.current_investigation_status` and
`current_development_outcome` are **denormalized read caches**. The
comment in `schema.ts` is explicit that application code must never write
these directly — they exist purely so a page render doesn't need to
compute "most recent history row" on every request, and are kept correct
exclusively by `sync_current_investigation_status()` /
`sync_current_development_outcome()`, two `AFTER INSERT` triggers on the
two history tables (migration 0002). If those triggers were ever removed
without a replacement, the cached columns would silently go stale — worth
flagging loudly if that trigger is ever touched.

### Claim relationships

`claim_relationships` — the "not a giant duplicate flag" graph.
`equivalent`, `subsumes`, `refines`, `contradicts`, `related`. Symmetric
types (`equivalent`, `related`, `contradicts`) are canonicalized at write
time in application code (`src/db/mutations/claimRelationships.ts`) —
the lower numeric claim id is always stored as `claim_id_a` — so "A
equivalent B" and "B equivalent A" collapse to the same row
deterministically, without a race-prone check-then-insert. Directional
types (`subsumes`, `refines`) are stored exactly as submitted, since
direction is the meaningful part.

### Evidence

`evidence` deliberately has **no direct `claim_id`** — it's extracted
from a source item first and may validly exist before being matched to
any claim, and one piece of evidence can bear on more than one claim
(one leaked build clip can be evidence for both a "setting" claim and a
"protagonist" claim). `claim_evidence` is the many-to-many join, with a
`stance` (`supports`/`contradicts`/`mentions`). Evidence with zero
`claim_evidence` rows is unlinked, awaiting review — a normal state, not
an invalid one.

### AI + admin decision trail

`ai_jobs` (one invocation: operation, provider, model, status, token/cost
tracking) → `ai_results` (structured output + confidence + reasoning) →
`admin_decisions` (`approve`/`reject`/`edit`/`request_reanalysis`/
`direct_change`, always tied to an `admin_users` row). A rejected AI
proposal is fully recorded in `ai_results` + `admin_decisions` and
**must not** produce a row in either status-history ledger — only
transitions that actually became effective go there. `direct_change`
exists for human edits with no AI proposal behind them at all
(`ai_result_id` is nullable on `admin_decisions` for exactly this case).

### Status history (the two append-only ledgers)

`claim_investigation_status_history` and
`claim_development_outcome_history`. Each row: `previous_status` (null on
the first row for a claim), `new_status`, `reason` (required — no
transition without one), `confidence`, `initiated_by`
(`ai`/`human`/`system`), and optional links back to the `ai_results` row
and/or `admin_decisions` row that produced it. `claim_status_timeline` is
a read-only `UNION ALL` view combining both ledgers chronologically for
display, without weakening the per-axis enum typing on the underlying
tables.

Immutability is enforced twice, deliberately redundantly:
1. **Grants** — `admin_role` only ever receives `SELECT, INSERT` on these
   tables, never `UPDATE`/`DELETE`. This is the primary control.
2. **Trigger** — `reject_status_history_mutation()` raises on any
   `UPDATE`/`DELETE` regardless of role, as defense-in-depth against a
   hypothetical future role that did have the grant.

`admin_audit_log` (general admin activity, distinct from
`admin_decisions`, which is scoped specifically to AI-recommendation
review) gets the identical append-only treatment.

### Transition evidence: tying evidence to a specific transition

`investigation_transition_evidence` and
`development_transition_evidence` — two many-to-many join tables, one per
ledger, each linking a specific row in `claim_investigation_status_history`
/ `claim_development_outcome_history` (`transition_id`) to a specific
`evidence` row (`evidence_id`), with a unique constraint on the pair so
the same evidence can't be linked twice to the same transition.

The distinction these tables exist to make: `claim_evidence` (see
"Evidence" above) records that a piece of evidence bears on a *claim* in
general. These two tables record something narrower and more specific —
that a piece of evidence was the actual justification for *one particular
status change*. A claim can accumulate evidence for months without any of
it individually triggering a transition; when a transition does happen,
these tables are what let a later reviewer ask "what specifically
justified moving this claim to Confirmed on this date," rather than only
being able to see everything ever linked to the claim as a whole and
having to guess which parts were relevant to which change. This is the
same "represent uncertainty and specificity rather than flattening it"
principle behind `source_relationships` and the two-axis status model —
here applied to the evidentiary basis for history itself.

---

## Migration history reconciliation

**Context:** during a post-Phase-3 architecture review, the live staging
database reported 8 applied migrations while the repository contained
only 6 files. This section records exactly what the discrepancy was, how
it was confirmed, and what was fixed — so it doesn't need to be
rediscovered.

### What the two extra live-only migrations actually did

Supabase's `supabase_migrations.schema_migrations` table stores the exact
SQL `statements` that were applied, not just a name — so this was
verified directly against staging rather than inferred.

**`create_app_and_admin_roles`** (applied *before* `0000_base_schema`):
```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role WITH LOGIN PASSWORD '<redacted, generated>';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role') THEN
    CREATE ROLE admin_role WITH LOGIN PASSWORD '<redacted, generated>';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;
GRANT CONNECT ON DATABASE postgres TO admin_role;
GRANT USAGE ON SCHEMA public TO admin_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO admin_role;
```
This was a one-off manual bootstrap step, run directly against Supabase,
that predated migration-history tracking for this project and was never
captured as a repo-controlled migration file.

**`fix_topics_project_fk`** (applied between `0000_base_schema` and
`0001_evidence_and_taxonomy`):
```sql
ALTER TABLE "topics" DROP CONSTRAINT "topics_project_id_projects_id_fk";
ALTER TABLE "topics" ADD CONSTRAINT "topics_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE no action ON UPDATE no action;
```
Verified against the live schema (`pg_get_constraintdef`) that the
resulting constraint is byte-for-byte identical to what
`0000_flashy_harrier.sql` already declares. This was a no-op fix applied
during initial setup — the end state matches the repo exactly. **No repo
change was needed for this one.**

### Verdict

- `fix_topics_project_fk` — **Category A**: already fully represented in
  the repo; only the migration-history bookkeeping differed. No action
  needed beyond this record.
- `create_app_and_admin_roles` — **Category B**: real drift. A fresh
  install from the repo's migrations alone would fail. Confirmed by
  actually reproducing it (see "How this was tested" below) — running
  migrations 0000-0005 in order against a clean database failed at
  migration 0002 with `ERROR: role "app_role" does not exist`, because no
  repo migration ever created that role.

Two further, related issues were found while diffing the *exact* applied
statements for `0004_admin_foundation` against the committed file (also
retrieved from `supabase_migrations.schema_migrations.statements`):

- The committed file's `CREATE ROLE admin_role WITH LOGIN PASSWORD
  'admin_dev_password'` block — a real, usable, committed credential —
  was **not** part of what actually ran on staging (it was stripped
  before applying, presumably by hand, since `admin_role` already existed
  from the bootstrap step above). Fixing this is also item 4 of the
  cleanup, but it's the same drift.
- The committed file's `GRANT CONNECT ON DATABASE gta6_intel TO
  admin_role` also was **not** part of what actually ran — Supabase's
  database is named `postgres`, not `gta6_intel`, so this line would have
  errored on a fresh Supabase install.

### The fix

Both `0002_audit_integrity.sql` and `0004_admin_foundation.sql` were
edited in place (not replaced wholesale — the exception to "don't rewrite
historical migrations" applies here because the file as committed simply
does not reproduce staging; that's a structural bug, not a style
preference):

- `app_role` (in 0002) and `admin_role` (in 0004) are now each created
  idempotently (`IF NOT EXISTS`) and **`NOLOGIN`** — no password is ever
  committed to source control.
- The `GRANT CONNECT ON DATABASE ...` line in both now targets
  `current_database()` via a dynamic `EXECUTE format(...)`, rather than a
  hardcoded name, so the same migration file works unmodified whether the
  target database is named `postgres` (Supabase) or something else
  (local).
- Both edits are idempotent no-ops when replayed against the current
  staging database (the roles already exist there, created `LOGIN` with
  real passwords by the original manual bootstrap step) — so this fix
  does not need to be, and was not, applied as a change to staging
  itself. It only affects what a *fresh* install experiences.
- A new file, `scripts/setup-db-roles.sql`, is the separate,
  environment-driven step that grants `LOGIN` + a real password to both
  roles after the migrations run. It takes the passwords as `psql`
  variables (`-v app_role_password=... -v admin_role_password=...`),
  never as a value written into the script.

### How this was tested

A local PostgreSQL 16 instance was used (not the staging database, to
avoid any risk to it):

1. Reproduced the failure first, unmodified: applied
   `0000_flashy_harrier.sql` through `0005_fix_admin_role_sequence_grants.sql`
   in order against a clean database — confirmed the exact failure
   (`role "app_role" does not exist` at 0002, cascading failures at 0004
   and 0005).
2. Applied the fixes described above.
3. Re-ran all six migrations, in order, against a freshly dropped and
   recreated database — **all six applied without error.**
4. Ran `scripts/setup-db-roles.sql` against that database — confirmed
   both roles gained `rolcanlogin = true`.
5. Connected as `app_role` and confirmed: `SELECT` on `claims` succeeds;
   `INSERT` on `projects` and on `claim_investigation_status_history`
   both correctly fail with `permission denied`.
6. Connected as `admin_role` and confirmed: `INSERT` on `projects`,
   `claims`, `admin_users`, and `claim_investigation_status_history` all
   succeed; the `sync_current_investigation_status` trigger correctly
   propagated the new status to `claims.current_investigation_status`;
   `UPDATE` on `claim_investigation_status_history` correctly fails
   (blocked at the grant level, which is the primary control — the
   redundant trigger was not separately exercised by this test since the
   grant already prevents the statement from running).

This confirms: **a database built from the repository's migrations alone
now reproduces the staging database's role/grant structure correctly.**

---

## Data API lockdown

**Context:** a post-cleanup security audit found that Supabase's
auto-generated Data API (PostgREST) had no real access control on top of
it. Every table in `public` had Row Level Security disabled *and* full
CRUD grants (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`) to Supabase's
built-in `anon` and `authenticated` roles — the roles the Data API uses,
reachable with the publishable/anon key, which is necessarily public (it
ships to the browser so Supabase Auth's client SDK can work). This meant
every table — including `admin_users`, `admin_audit_log`,
`admin_decisions`, and both append-only status-history ledgers — was
potentially directly readable and writable through a path that completely
bypasses the application, `app_role`/`admin_role`, admin authentication,
and the append-only protections, none of which that path goes anywhere
near.

**Verified before changing anything:**
- `edge_logs` showed zero historical `/rest/v1/*` requests — no evidence
  the exposure had been exploited, but that says nothing about future
  risk.
- The only Supabase JS client usage anywhere in the codebase is
  `supabase.auth.signInWithPassword()` on the admin login page. Nothing
  in the app ever calls `.from()`, `.rpc()`, or any other PostgREST
  method — confirming the app has zero functional dependency on the Data
  API for business data, so locking it down could not break anything the
  app actually does.
- All 22 application tables were owned by `postgres`, not
  `app_role`/`admin_role` — meaning enabling RLS would also block those
  two roles unless explicitly exempted (see below).

**Design chosen — Option B (deny-by-default), not Option A:** disabling
the Data API's exposure of the `public` schema entirely (Option A) is a
Supabase project-level setting (Dashboard → Settings → API → Data API
Settings → "Exposed schemas"), not something representable in a SQL
migration — the Supabase Management API that controls it is a separate
HTTPS API from the Postgres connection migrations run over, and no tool
available in this environment could read or change it. That remains
worth checking directly (see "Action still required" below), but the fix
below closes the vulnerability regardless of that toggle's state, so it
wasn't a blocker.

Rather than authoring per-table RLS policies to replicate what
`app_role`/`admin_role` already do correctly via `GRANT` (which the
project's own principles call out as unnecessary complexity — "prefer
deny-by-default rather than dozens of permissive policies"), migration
`0006_lock_down_data_api.sql` does three things:

1. Revokes schema-level `USAGE` and all object privileges (tables,
   sequences, functions) from `anon`/`authenticated` on `public`, plus
   `ALTER DEFAULT PRIVILEGES` so future objects don't automatically
   re-grant them anything either.
2. Enables Row Level Security on all 22 tables with **zero policies** —
   independent, second-layer protection: even if a future migration
   accidentally re-grants a privilege, RLS still blocks every row for any
   role that isn't the table owner and doesn't have `BYPASSRLS`.
3. Grants `BYPASSRLS` to `app_role` and `admin_role` specifically, so RLS
   is completely transparent to them — their existing grant-based scoping
   (unchanged by this migration) remains the only thing that governs their
   access, exactly as designed in migrations 0002/0004.

`claim_status_timeline` (a view, not a table) needed no separate step —
views don't have their own RLS switch; they run against the querying
role's privileges on the underlying tables, which the above already
covers.

**Verified after:** using `SET ROLE anon` / `SET ROLE authenticated`
directly against the live staging database (the most precise way to
simulate exactly what a real Data API client session sees) — `SELECT` on
`claims`, `SELECT` on `admin_users`, `INSERT` on
`claim_investigation_status_history`, and `INSERT` on `claims` all
correctly returned `permission denied`. `app_role`/`admin_role` grants
were confirmed byte-for-byte unchanged by diffing
`information_schema.role_table_grants` before and after. The full fix was
also independently verified end-to-end (fresh install, seed, both check
scripts, running app hitting every public/admin route, a real
`admin_role` status transition, and confirming `UPDATE` on the history
ledger still fails) against a local Postgres instance built from the
complete 0000–0006 migration set before being applied to staging.
`auth` schema privileges for `anon`/`authenticated` were confirmed
untouched — Supabase Auth is unaffected.

**Action still required (outside this repo):** in the Supabase dashboard,
check Settings → API → Data API Settings, and confirm whether `public` is
listed under "Exposed schemas." If it's not necessary for anything, remove
it — this is optional additional hardening (the migration above already
closes the vulnerability regardless), but removes the Data API's ability
to see the schema at all rather than relying on it correctly enforcing
zero access.

## SEO base URL

Previously hardcoded to `https://example.com` in three separate places
(`src/app/layout.tsx`, `src/app/robots.ts`, `src/app/sitemap.ts`).
Replaced with one central resolver, `src/lib/siteConfig.ts`, used by all
three. Resolution order: explicit `NEXT_PUBLIC_SITE_URL` env var, then
Vercel's automatic `VERCEL_URL`, then `http://localhost:3000` for local
dev.

**Action required in Vercel project settings:** set
`NEXT_PUBLIC_SITE_URL=https://gta6-intel.vercel.app` explicitly for the
staging deployment. The `VERCEL_URL` fallback alone is not sufficient for
this, because Vercel sets `VERCEL_URL` to the specific build's deployment
URL (e.g. a random-hash preview URL), not the stable alias domain — so
without the explicit env var, generated sitemap/canonical URLs would
point at the wrong host on some builds.

---

## Credential cleanup

Beyond the `admin_dev_password` fix described above (folded into the
migration reconciliation, since it was the same drift), three more files
had the same pattern — a hardcoded fallback connection string
(`postgresql://migrator_role:migrator_dev_password@localhost:5432/gta6_intel`)
used when an env var was unset:

- `drizzle.config.ts`
- `src/db/seed/seed.ts`
- `src/checks/adminAuth.check.ts`

All three now throw a clear, explicit error naming the missing env var
and pointing at this documentation, instead of silently falling back to a
committed credential-shaped string. None of these were ever usable
against staging (they only ever pointed at `localhost`), but a
password-shaped string does not belong in source control regardless of
how narrow its blast radius is.
