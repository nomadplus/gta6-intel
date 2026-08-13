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
