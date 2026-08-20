# The Ledger — GTA VI Claim Archive

A provenance-aware claim-tracking platform for Grand Theft Auto VI. It is
**not** a news aggregator. It tracks individual, atomic *claims* about the
game — a setting, a character, a mechanic, a date — each with its own
evidence, its own sources, and its own history of what was believed about
it over time. Fifty articles repeating one leak don't make it five times
as true, and a report can be entirely accurate the day it's published even
if the feature it describes is later changed or cut. Both facts are
represented distinctly, and neither is silently erased.

**Live staging:** https://gta6-intel.vercel.app

---

## The core idea: claims, not articles

A **claim** is a single, discrete proposition ("GTA VI is set in a
fictionalized version of Miami called Vice City") that persists
independently of any article that reported it. Claims are evaluated on
two **separate axes**, because they answer different questions and can
diverge:

- **Investigation Status** — how well-evidenced the claim itself is
  (`unverified → corroborated → strongly_corroborated → confirmed`, or
  `disproven` / `unresolvable`), independent of what shipped.
- **Development Outcome** — what actually happened in the game
  (`unknown`, `reflected_in_development`, `changed_during_development`,
  `cut`, `in_final_game`, `not_applicable`), independent of how good the
  reporting was.

A claim can be *Confirmed* (the reporting was accurate) and *Cut* (the
feature didn't ship) at the same time — this combination is the case the
UI's `StatusPair` component and its regression check
(`src/checks/statusPresentation.check.ts`) exist specifically to prove
out.

Claims are also typed by **information type**: `fact`, `official`,
`report`, `leak`, `rumour`, `speculation`, `prediction`, `interpretation`
— the platform never silently converts one into another.

Sources report claims; **evidence** is separate from sources and is
many-to-many with claims (one clip can support two different claims;
evidence can exist unlinked, awaiting review). **Provenance** between
source items is tracked explicitly (`original`, `independent_corroboration`,
`citation`, `repetition`, `aggregation`, `derivative`, `unknown`) — the
platform never assumes that many pages repeating a leak count as
independent confirmation of it. See `docs/architecture.md` for the full
data model.

---

## Technology stack

- **Framework:** Next.js 16 (App Router), React 19
- **Database:** PostgreSQL (Supabase-hosted for staging/production)
- **ORM / migrations:** Drizzle ORM + Drizzle Kit (`src/db/schema.ts`,
  `src/db/migrations/`)
- **Auth:** Supabase Auth (`@supabase/ssr`)
- **Styling:** Tailwind CSS 4
- **Validation:** Zod
- **Hosting:** Vercel
- **Language:** TypeScript throughout, `tsx` for scripts/checks (no
  compiled test framework — see "Test / check commands" below)

---

## Public-site architecture

Route group: `src/app/(public)/`. Server-rendered Next.js pages —
`/`, `/claims`, `/claims/[id]-[slug]`, `/timeline`, `/topics`,
`/topics/[slug]`, `/confirmed`, `/graveyard`. All public pages read
through `src/db/queries/*`, which use `src/db/client.ts` — a connection
authenticated as `app_role`, a Postgres role with **read-only** access
(see "Database role separation" below). The public site never has a
code path capable of writing to the database, and never invokes AI on a
page view — AI processing (once built, in a later phase) will happen
during ingestion and its results will be stored, not computed on request.

Claim URLs are `/claims/{id}-{slug}` — the numeric id is the real,
permanent identifier used in every foreign key and lookup; the slug is
cosmetic/SEO-only and can be edited without ever breaking a link.

`src/app/sitemap.ts` and `src/app/robots.ts` generate their URLs from a
single central config (`src/lib/siteConfig.ts`) — see "SEO base URL" in
`docs/architecture.md`.

---

## Admin architecture

Route group: `src/app/admin/`, with a nested `(protected)/` group holding
everything that requires authentication. `admin/login` is the one public
route.

- **`src/app/admin/(protected)/layout.tsx`** calls `requireAdmin()` and
  redirects unauthenticated visitors to `/admin/login`. This protects
  page *rendering*.
- **Every mutation function in `src/db/mutations/*` independently calls
  `requireAdmin(minRole)` itself**, before touching the database. This is
  deliberate and necessary, not redundant: Next.js Server Actions
  (`src/app/admin/(protected)/*/actions.ts`) are callable directly and can
  bypass a layout, so the layout check alone would not be a real security
  boundary. The mutation-level check is the actual enforcement point.
- All mutations run inside `withAuditedTransaction` (`src/db/mutations/shared.ts`),
  which writes a row to `admin_audit_log` in the same transaction as the
  data change, so no admin write can happen without a corresponding audit
  record.
- Admin mutations connect as `admin_role` (`src/db/adminClient.ts`), a
  Postgres role separate from the public site's `app_role` — see below.

Roles, ranked low → high: `read_only_analyst`, `reviewer`, `editor`,
`owner`. Role-sufficiency logic lives in `src/lib/auth/authorization.ts`,
deliberately with zero I/O and zero `server-only` dependency, so it can
be unit-tested directly (see `src/checks/adminAuth.check.ts`).

---

## Database role separation

Three Postgres roles, enforced with real `GRANT`/`REVOKE`, not just
application-level checks:

| Role | Used by | Access |
|---|---|---|
| `migrator_role` (or your local Postgres superuser / Supabase's project owner) | Running migrations | Full DDL |
| `app_role` | Public site (`src/db/client.ts`) | `SELECT` only on everything |
| `admin_role` | Admin mutations (`src/db/adminClient.ts`), used only *after* `requireAdmin()` has verified the caller | `SELECT/INSERT/UPDATE/DELETE` on normal tables; `SELECT + INSERT` only (no `UPDATE`/`DELETE`) on the append-only ledgers |

The two status-history ledgers (`claim_investigation_status_history`,
`claim_development_outcome_history`) and `admin_audit_log` are
append-only at the database level: `admin_role` is never granted
`UPDATE`/`DELETE` on them, and a trigger
(`reject_status_history_mutation`) blocks it as defense-in-depth even for
a hypothetical future role that did have the grant.

Role *creation* is idempotent and repo-controlled (migrations 0002 and
0004), but roles are created `NOLOGIN` — no password is ever committed to
this repository. Granting `LOGIN` and a real password is a separate,
environment-driven step: see `scripts/setup-db-roles.sql` and "Local
development" below.

---

## Supabase Auth

Real Supabase Auth via `@supabase/ssr` (`src/lib/supabase/server.ts`,
`src/lib/supabase/client.ts`), reading the session from request cookies.
`admin_users.auth_user_id` links an authenticated Supabase Auth identity
to an application-level role.

For local development without a live Supabase project reachable, setting
`LOCAL_FAKE_ADMIN_AUTH_USER_ID` (with `NODE_ENV` anything other than
`production`) makes `getSession()` return a fixed fake session instead of
verifying a real cookie — this exists purely to exercise
authorization/route-gating logic locally, and is double-guarded (env var
**and** a `NODE_ENV !== "production"` check) against ever firing in a
real deployment. It does **not** exercise real login, OAuth, or cookie
verification — that must be checked against a real Supabase project
before any deployment that touches auth.

---

## Migration workflow

Schema lives in `src/db/schema.ts` (Drizzle). Migration SQL files live in
`src/db/migrations/000N_name.sql`, generated with `drizzle-kit generate`
and reviewed by hand before being applied (several contain hand-written
triggers, views, and role grants that aren't expressible in the Drizzle
schema DSL). Migrations are applied to Supabase via the Supabase CLI/
dashboard, tracked in `supabase_migrations.schema_migrations` — the
Drizzle migration runner itself is not used to apply migrations against
Supabase.

**A fresh install requires the migrations in order, 0000 → 0005, followed
by `scripts/setup-db-roles.sql`** (see below) to grant `app_role`/
`admin_role` a real password. This full path is verified — see
`docs/architecture.md` for what was found and fixed during the migration
history reconciliation, and how it was tested.

Do not edit an already-applied migration file except to fix a genuine
reproducibility bug (as happened once — see `docs/architecture.md`).
Prefer a new migration file for anything else.

---

## Environment variables

Names only — real values are never committed. Set these in `.env.local`
for local development and in Vercel's project settings for staging/
production.

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | public site, seed script, drizzle-kit | `app_role` (or `migrator_role` for drizzle-kit/seed) connection string |
| `ADMIN_DATABASE_URL` | admin mutations | `admin_role` connection string |
| `CHECK_DATABASE_URL` | `src/checks/adminAuth.check.ts` | connection string for the auth check's fixture verification |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Auth client (server + browser) | your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Auth client (server + browser) | Supabase anon/public key |
| `NEXT_PUBLIC_SITE_URL` | `src/lib/siteConfig.ts` (sitemap, robots, metadata) | canonical public base URL; set to `https://gta6-intel.vercel.app` for staging |
| `LOCAL_FAKE_ADMIN_AUTH_USER_ID` | `src/lib/auth/session.ts` | **local development only** — see "Supabase Auth" above |
| `INGESTION_REVIEW_SIGNING_SECRET` | `src/lib/ingestion/reviewPayloadSigning.ts` | HMAC secret binding manual-ingestion review data (retrieved URL, content hash) to the admin's confirm request, so hidden form fields can't substitute tampered values — see that file's header comment. Generate with e.g. `openssl rand -hex 32`; rotating it invalidates any in-flight (unconfirmed) review tokens, which is safe — the admin just resubmits the URL. |

---

## Local development

1. Install Postgres locally (or point at a Supabase project) and create a
   database.
2. Create a privileged role to run migrations (`migrator_role`, or use
   your local superuser) — this is a one-time manual step; no migration
   creates its own migrator role, since a role capable of running DDL has
   to exist before any DDL can run.
3. Apply the migrations in order:
   ```
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0000_flashy_harrier.sql
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0001_evidence_and_taxonomy.sql
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0002_audit_integrity.sql
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0003_claim_slugs.sql
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0004_admin_foundation.sql
   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0005_fix_admin_role_sequence_grants.sql
   ```
4. Provision passwords for `app_role`/`admin_role` (created `NOLOGIN` by
   the migrations above):
   ```
   psql "$MIGRATOR_DATABASE_URL" \
     -v app_role_password="$(openssl rand -base64 24)" \
     -v admin_role_password="$(openssl rand -base64 24)" \
     -f scripts/setup-db-roles.sql
   ```
   Use the same passwords you pass here in the `DATABASE_URL` /
   `ADMIN_DATABASE_URL` you put in `.env.local`.
5. `npm install`
6. `npm run db:seed` (uses `DATABASE_URL`) to load representative Phase 1
   test data.
7. `npm run dev`

## Test / check commands

There is no compiled test framework (Jest/Vitest) yet — checks are plain
`tsx` scripts under `src/checks/`, run directly:

```
npx tsx src/checks/adminAuth.check.ts          # requires CHECK_DATABASE_URL
npx tsx src/checks/statusPresentation.check.ts # no database needed
```

or via the npm script alias:

```
npm run check:status-presentation
```

Also run before considering any change complete:

```
npm run typecheck
npm run build
```

## Vercel deployment

Deployed from this repository via Vercel's standard Next.js integration.
All environment variables listed above must be set in the Vercel project
(Production and Preview as appropriate). `NEXT_PUBLIC_SITE_URL` should be
set explicitly to the deployment's real public domain — do not rely on
Vercel's automatic `VERCEL_URL` alone for the production alias, since
`VERCEL_URL` resolves to the specific build's deployment URL rather than
the stable alias domain.

**Current staging deployment:** https://gta6-intel.vercel.app

---

## Completed phases

- **Phase 1** — Core claim/status/history data model, public site
  read-only presentation, the Investigation Status / Development Outcome
  two-axis design.
- **Phase 2** — Evidence, source taxonomy (lookup tables), provenance
  relationships between source items, claim relationships (with symmetric
  canonicalization), claim slugs/URLs.
- **Phase 3** — Admin foundation: Supabase Auth, `admin_users` +
  application-level roles, `admin_audit_log`, two-tier Postgres role
  separation (`app_role` read-only / `admin_role` for authorized
  mutations), full admin CRUD UI for claims/sources/source items/evidence/
  topics/relationships.
- **Post-Phase-3 cleanup** (this document's companion,
  `docs/architecture.md`) — migration history reconciliation, this
  documentation, SEO base URL centralization, credential cleanup.

No AI integration, scraping, ingestion pipeline, or embeddings exist yet
— that is Phase 4 and later, not yet started.

---

## Core architectural rules

These are enforced in code/schema, not just convention — see
`docs/architecture.md` for where:

- Status history is **append-only** — enforced by both Postgres grants
  and a trigger, not just application code.
- **Investigation Status and Development Outcome are separate axes** and
  must never be merged into one field or one label.
- **Evidence is many-to-many with claims**, and evidence with zero claim
  links is a valid, normal "awaiting review" state, not an error.
- **Provenance relationships between sources are explicit and typed** —
  repetition, citation, and aggregation are never conflated with
  independent corroboration.
- **AI recommendations are not automatic truth.** The schema
  (`ai_jobs` → `ai_results` → `admin_decisions` → status history) is
  built so that no AI output can become an effective status change
  without a recorded admin decision — this structure exists already, even
  though no AI integration has been built yet.

For the full schema-level detail behind each of these, see
`docs/architecture.md`.
