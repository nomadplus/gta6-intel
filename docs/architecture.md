# Architecture notes

Companion to the root `README.md`. This document covers the data model in
more detail; the Phase 4 ingestion pipeline, Phase 5 AI operations, and
Phase 6 prerequisite (outbound-link provenance evidence); and keeps a
record of the post-Phase-3 cleanup work (migration history
reconciliation, SEO base URL, credential removal) so future changes
don't rediscover the same issues from scratch.

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
platform does not store full-article copies. (Phase 6 prerequisite:
`source_item_links` extends this same discipline to outbound links —
see "Outbound link observations" below — storing only a small,
per-link-scoped context snippet, never article bodies.)

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

**Direction convention (Phase 5 PR 8a):** `source_item_id_a` is the
**subject**; `source_item_id_b` is the **object**. A row
`(a = 7, b = 9, 'citation')` asserts *"source item 7 cites source item
9"*. Because the table is deliberately not canonicalized, both
`(7, 9, 'citation')` and `(9, 7, 'citation')` may legitimately exist as
two different facts, and this orientation must never be normalized away.

This paragraph previously said only that direction was meaningful,
without saying which column carried it — and that omission was the root
cause of a real defect. The admin creation form bound "this item" to
`sourceItemIdB` and the other item to `sourceItemIdA`, so every
relationship created through the UI was *stored as the inverse of what
the admin entered*. All three readers (`getSourceItemRelationships`,
`getClaimProvenanceChain`, `ProvenanceChain`) were individually correct
and faithfully displayed the inverted row, and the audit summary was
self-consistent with the *form* rather than with storage — so the audit
trail described the admin's intent while the database held its opposite,
which is why it never surfaced on inspection. `src/db/seed/seed.ts`
writes `a` = subject directly, bypassing the form, so all seeded data was
always correct.

PR 8a fixed the form binding and the audit summary, and consolidated the
one verb vocabulary into `src/lib/provenanceDirection.ts` so the audit
sentence and the public provenance chain cannot drift apart again.
`src/checks/provenanceDirectionRoundTrip.check.ts` locks write-path /
read-path agreement against a real database — a pure check cannot catch a
disagreement in which every component is individually self-consistent.
No migration and no data correction were required: only two
`source_relationships` rows existed, both written by the seed path and
both correct, and `admin_audit_log` held no
`entity_type = 'source_relationship'` entries at all, proving no row had
ever been created through the defective form.

One asymmetry worth noting for future graph code: for the four
dependence types (`citation`, `repetition`, `derivative`, `aggregation`)
the subject is the *later, dependent* item, whereas for `original` the
subject is the *earlier, origin* item. The `a` = subject invariant holds
for all seven types; only the temporal meaning of the subject position
differs.

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

### Discovery feeds (Phase 4 PR 8 — feed configuration only)

`discovery_feeds` (migration 0011) lets an admin register RSS/Atom feeds
to monitor. This PR is configuration storage only — no fetching,
parsing, scheduling, or `ingestion_jobs` creation exists yet; that is
PR 9's automated job processor and PR 10's RSS poller. `last_polled_at`/
`last_poll_status` are columns reserved for PR 10 and are written by
nothing until then.

**Why `feed_url` is a single column, unlike ingestion's submitted/
normalized/canonical trio:** `ingestion_jobs` and `source_items` each
keep the originally-submitted or originally-retrieved URL alongside its
normalized form, because that data is historical evidence — what was
actually submitted or fetched must be preserved verbatim for audit and
provenance, independent of how its normalized form is later computed.
`discovery_feeds.feed_url` has no such requirement: it is operational
configuration (which feed the system should poll right now), not a
historical record of an event that happened. There is nothing to
preserve "as originally typed" — if a feed's normalized form would
change (a tracking parameter stripped, a trailing slash removed), the
config should simply reflect the corrected value, not retain a stale
submitted variant next to it for no purpose. Accordingly, the admin
mutation layer (`src/db/mutations/discoveryFeeds.ts`) normalizes the
submitted feed URL via the existing `normalizeUrl()`
(`src/lib/ingestion/urlNormalization.ts`, reused rather than
reimplemented) *before* writing it, and `feed_url` stores only that
normalized result. This is also what makes the table's
`discovery_feeds_feed_url_unique` constraint actually work as intended:
uniqueness on a normalized column prevents equivalent duplicate feed
configurations (e.g. the same feed with and without a `utm_source` query
parameter), not merely byte-identical ones.

`source_id` is `NOT NULL` with no inline source creation from the feed
form — a feed always references an existing `sources` row, per product
decision; source creation stays in the existing Sources admin workflow.

### RSS/Atom discovery poller (Phase 4 PR 10 — closes Phase 4)

`src/app/api/discovery/poll/route.ts` is the automated poller that turns
`discovery_feeds` configuration (PR 8) into `ingestion_jobs` rows for PR
9's automated processor to pick up. It is a **separate route and cron
entry** from PR 9's `/api/ingestion/process`, not a phase added to that
route — two independent reasons:

1. **Time-budget contention.** PR 9's batch (5 jobs × up to 45s worst
   case each) can already use ~225s of the 300s Fluid Compute budget.
   Adding feed fetches (also up to 45s each via `safeFetch`) into the
   same invocation risked exceeding the limit on a bad day.
2. **PR 9's claim query has a 5-minute floor.**
   `claimEligibleIngestionJobsForProcessing` only treats a `'queued'` job
   as eligible once it's older than `RECOVERY_STALE_THRESHOLD_MS` (5
   minutes) — a job created moments earlier in the *same* invocation
   would fail that check and sit untouched for a full extra day. `
   vercel.json` schedules this poller at `04:00 UTC` and PR 9's processor
   at `06:00 UTC` — a two-hour gap, not one, chosen specifically because
   Vercel Hobby cron may fire "anywhere within the scheduled hour," so a
   one-hour gap could in principle collapse to under 5 minutes. Two
   hours comfortably clears that threshold with zero changes to PR 9's
   existing claim logic.

**Claiming (`src/db/mutations/discoveryPolling.ts`,
`claimDueDiscoveryFeeds`):** a short transaction selects due, enabled
feeds with `FOR UPDATE SKIP LOCKED` (same primitive PR 9 uses for
`ingestion_jobs` — two overlapping invocations simply skip a feed row
the other already holds), ordered oldest-`last_polled_at`-first so a
backlog larger than one batch drains fairly. Within that same
transaction, the claim writes `last_polled_at = now()` and
`last_poll_status = 'polling'` — a lock alone provides no protection
once the transaction commits and releases it, so the durable marker has
to land first. Accepted trade-off: if the invocation crashes mid-batch,
an already-claimed-but-unprocessed feed shows as "just polled" and waits
a full interval before being reconsidered — no separate
`last_poll_attempt_at`/stale-reclaim column was added for this in PR 10;
proportionate at the project's current scale, revisit if it ever isn't.

**Feed parsing (`src/lib/ingestion/feedParsing.ts`):** narrowed to
exactly one thing — extracting each item/entry's article URL. No title,
author, or date extraction here; that remains PR 4's
`metadataExtraction.ts`, applied later against the actual fetched
article page. Atom link selection prefers `rel="alternate"`, falling
back to a link with no `rel` at all, and never selects `self`/
`enclosure`/other rels.

Uses `fast-xml-parser` (pinned to an exact version — 5.11.0 as of this
PR; re-verify the pin at any future upgrade), defended in depth rather
than trusted on the pin alone, because this library has a real history
of DOCTYPE/entity-substitution vulnerabilities (unlimited entity
expansion, a numeric-character-reference bypass of that fix, a repeated-
DOCTYPE bypass of the expansion counters themselves, an entity-encoding
XSS bypass, and a RangeError crash on out-of-range numeric entities —
see `feedParsing.ts`'s file header for the full list with CVE/advisory
IDs and fixed versions). Three layers, not one:

1. Any feed body containing a `<!DOCTYPE` declaration is rejected
   outright, before the parser ever sees it — legitimate RSS/Atom feeds
   never declare one, so this closes the whole vulnerability class at
   the door regardless of version or future bypass.
2. `processEntities: false` disables DOCTYPE-driven and numeric-
   character-reference substitution entirely.
3. Because that leaves entities like `&amp;` undecoded, and a real
   article URL can legitimately contain one in its query string, a
   small dedicated decoder (`src/lib/ingestion/xmlEntityDecode.ts`) —
   not fast-xml-parser's own entity handling — decodes the five
   predefined XML entities and numeric character references in each
   already-extracted, short URL string, with a hard input-length cap.

**Dedupe: superseded by Phase 6 PR 6.2 (see below).** The
`createSystemDiscoveredJob` application pre-check described in the
original Phase 4 PR 10 design (a same-file, same-invocation
`ingestion_jobs` existence check plus a partial unique index race guard)
is retired — that function no longer exists. RSS discovery no longer
creates `ingestion_jobs` directly at all. The `ingestion_jobs_discovery_feed_normalized_url_unique`
partial unique index (migration 0012) still exists and is still checked
by the candidate-ledger promotion path described below (as one of
several unique-constraint conflicts `ON CONFLICT DO NOTHING` covers),
but the day-to-day dedupe work is now done further upstream, inside the
candidate ledger itself (candidate identity is one row per normalized
URL; see "Discovery candidate ledger" below).

**`ingestion_jobs.discovery_feed_id`** (migration 0012, nullable FK to
`discovery_feeds.id`) still records which feed produced a
system-discovered job — operational/pipeline provenance, populated only
when `initiated_by = 'system'` and always `NULL` for manual submissions.
As of PR 6.2, this column is populated by candidate promotion (copied
from the promotion origin observation), not by a direct insert at poll
time. Distinct from the epistemic `source_relationships` provenance
graph described above.

This route performs discovery-ledger recording and ingestion-job
queueing only — downstream article fetching/processing/claim/AI/provenance
work remains separate, owned by PR 9's processor. That separation
(`discovery` vs. `processing`) is deliberate: the two stages are
independently replaceable.

With PR 10 merged, Phase 4 is complete: every `discovery_feeds` row can
autonomously produce `ingestion_jobs`, and PR 9 autonomously processes
them end to end, with no admin click required anywhere in the loop.
**Phase 6 PR 6.2 (below) changes *how* that happens — RSS now writes
through the candidate ledger instead of inserting directly — without
changing this end-to-end guarantee.**

### RSS bridged through the discovery candidate ledger (Phase 6 PR 6.2)

`/api/discovery/poll/route.ts` no longer creates `ingestion_jobs`
directly. Every valid feed item is now recorded as a discovery sighting
through the Phase 6 PR 6.1 candidate ledger
(`recordDiscoverySighting()`, `src/db/mutations/discoveryCandidates.ts`),
then promoted in two bounded steps once every feed in that invocation
has finished polling:

```
claimDueDiscoveryFeeds()
        ↓
safeFetch + parseFeed (unchanged)
        ↓
per item: recordDiscoverySighting({ rawUrl, discoveryProviderId: rss,
                                     discoveryFeedId, admissibility: "eligible" })
        ↓ (on "recorded", collect candidateId into one invocation-wide Set)
[after ALL feeds finish]
claimEligibleCandidatesForPromotionByIds([...observedCandidateIds])
        ↓
claimEligibleCandidatesForPromotion(RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE)
        ↓
ingestion_jobs (queued) — unchanged downstream (PR 9's processor)
```

**Locked admissibility rule.** Every syntactically valid URL observed
through an enabled, admin-configured RSS/Atom feed receives
`admissibility: "eligible"`. This means **pipeline admission only** — it
conveys zero epistemic trust, confidence, corroboration, independence,
provenance weight, or truth status. Multiple RSS/feed observations of
the same URL remain operational discovery facts only
(`discovery_candidate_observations` rows, per PR 6.1's own design) and
never influence `claims`, `evidence`, `source_relationships`, claim
confidence, public status, or any provenance conclusion. That graph
remains exclusively `analyse_provenance`'s and, ultimately, a human
reviewer's to decide — though `analyse_provenance` is not the *only*
mechanism by which a `source_relationships` row can ever come to exist;
existing human/admin review and write paths on that table remain valid
independent of it. All existing downstream AI/human review safeguards
are entirely unaffected by this bridge — a promoted candidate produces
exactly the same `ingestion_jobs` row shape (`status: 'queued'`,
`initiated_by: 'system'`) the old direct-insert path produced, entering
the same downstream pipeline.

**Two-step bounded promotion, no unbounded loop, no shared batch-size
competition.**

1. `claimEligibleCandidatesForPromotionByIds(candidateIds)`
   (`src/db/mutations/discoveryCandidates.ts`) — promotes exactly the
   candidate IDs observed by this invocation (deduplicated into one
   `Set` across every feed the invocation polled). Internally this is
   the *same* `selectClaimableCandidates()` query the global function
   uses, with one additional `inArray(discoveryCandidates.id,
   candidateIds)` condition AND-ed in, and the *same* shared
   `promoteClaimedCandidates()` helper (extracted from what was
   previously `claimEligibleCandidatesForPromotion`'s own inline loop)
   — every exclusion, origin-selection, and `ON CONFLICT DO NOTHING`
   race rule from PR 6.1 applies identically. This exists because
   `selectClaimableCandidates()` orders oldest-first across the *whole*
   ledger: an unscoped, shared-`LIMIT` call would let an unrelated
   historical backlog compete for the same batch and potentially starve
   the candidate IDs observed by this invocation. Filtering to exactly
   the ids this caller observed removes that competition structurally —
   the query can only ever match rows from the caller's own set. An
   empty `candidateIds` array returns `[]` immediately, no transaction
   opened.
2. `claimEligibleCandidatesForPromotion(RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE)`
   — **one bounded call, never looped** — recovers eligible candidates
   left behind by an earlier invocation whose own promotion step failed
   partway (crash, timeout). `RSS_POLL_BACKLOG_RECOVERY_BATCH_SIZE` is
   locked at `250`, derived from and pinned (via
   `src/checks/discoveryPolling.check.ts`'s live invariant check, not a
   hardcoded duplicate) to
   `DEFAULT_FEED_POLL_BATCH_SIZE × MAX_ITEMS_PER_FEED = 5 × 50 = 250`.
   This provides bounded global recovery capacity of up to 250
   candidates per successful poll invocation, matching one worst-case
   poll's maximum candidate output — it does **not** guarantee that
   every candidate stranded by one failed poll is always fully cleared
   by exactly the next invocation: `FOR UPDATE SKIP LOCKED` can
   temporarily skip a row still locked by concurrent activity, this
   call's 250 slots are shared across the entire eligible, claimable
   backlog (not reserved for any one prior failure), and some
   candidates may be historically excluded (their normalized URL already
   exists in `ingestion_jobs`/`source_items`) rather than genuinely
   promotable at all. What 250 does guarantee is bounded, monotonic
   forward progress on whatever backlog is currently claimable, every
   successful invocation. This second call is genuinely global (no id
   restriction), so it is *possible* — though not the common case — for
   it to promote a candidate from the same invocation that `SKIP LOCKED`
   had briefly made unavailable to the id-scoped call and that became
   claimable by the time this second call ran; not every row promoted
   here is necessarily old historical backlog, which is why the route's
   own observability names this metric `globalRecoveryPromoted` rather
   than implying every result is backlog.

**No new database migration.** Every column, index, trigger, and
constraint this bridge needs already exists from migration 0028 (PR
6.1) — PR 6.2 is caller-side wiring plus one new promotion entry point
(`claimEligibleCandidatesForPromotionByIds`) built by extending the
existing internal query/helper functions in
`src/db/mutations/discoveryCandidates.ts`, not by touching the schema.

**URL normalization: a single authoritative boundary.**
`recordDiscoverySighting()` already calls the canonical `normalizeUrl()`
internally and returns `{ outcome: "invalid_url", reason }` *before*
touching either ledger table. The poll route no longer calls
`normalizeUrl()` itself — a second call at the route level would be
redundant, not defense-in-depth, since it would be the same pure
function run twice on the same input. A malformed/unsupported URL still
produces zero `discovery_candidates` rows, zero
`discovery_candidate_observations` rows, and zero `ingestion_jobs` rows.

**Observability.** Per feed: `itemsParsed`, `sightingsRecorded` (a valid
sighting that passed through `recordDiscoverySighting()` — may be a
same-feed replay; the ledger's own design deliberately does not expose
that distinction, so this route never claims to know it either — never
described as "new"/"created"), `malformedUrlsSkipped`. At the
invocation level: `uniqueCandidateIdsObserved`, `currentPollPromoted`,
`globalRecoveryPromoted`, `totalJobsPromoted`. No per-feed job/promotion
attribution is attempted or logged — `PromotedCandidate` is not extended
for this purpose, and no extra database reads are added solely to
manufacture that grouping.

**Manual ingestion is completely unaffected.** `src/db/mutations/ingestion.ts`
(the admin-request-driven mutation surface) shares no code path with any
of this — it never called `createSystemDiscoveredJob` and does not call
`recordDiscoverySighting`/`claimEligibleCandidatesForPromotion(ByIds)`
either.

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

### AI provider abstraction (Phase 5 PR 1)

`src/lib/ai/` is the provider-neutral contract layer every future real
AI operation (`classifyRelevance`, `extractClaims`, `compareClaims`,
`analyseProvenance`, `evaluateEvidence`, `recommendStatus`,
`detectDuplicates`) is expected to call through, rather than talking to
an SDK or to `ai_jobs`/`ai_results` directly:

- **`types.ts`** — the `AiOperation` union (a plain literal mirror of the
  `ai_operation` enum, kept dependency-free from drizzle-orm on purpose)
  and the `AiProvider` interface: one method, `complete<T>()`, taking an
  operation-specific Zod `outputSchema` supplied by the *caller* — this
  file has no opinion about what any specific operation's schema looks
  like, so adding a new operation never requires editing it.
- **`config.ts`** — `getDefaultModel()` / `getAnthropicApiKey()`, both
  read lazily (at call time, not import time) so importing anything
  under `src/lib/ai/` never fails a build/typecheck/check run in an
  environment that hasn't configured `AI_DEFAULT_MODEL` or
  `ANTHROPIC_API_KEY` — only code paths that actually construct a real
  provider or resolve a default model need them set.
- **`providers/anthropicProvider.ts`** — the one real implementation.
  Uses a single forced tool call (`tool_choice: {type:"tool", ...}`)
  whose `input_schema` is the caller's Zod schema converted via Zod 4's
  native `z.toJSONSchema()` (no extra dependency needed for that
  conversion), then re-validates the tool call's input against the same
  schema before returning it — never a blind cast of whatever the model
  claims to have produced. `getAnthropicProvider()` is a lazy,
  memoized factory; constructing it is the point at which "we need a
  real Anthropic key" becomes true, not module import.
- **`aiJobLifecycle.ts`** — pure patch-builder functions for the
  `ai_jobs` `pending → running → succeeded/failed` lifecycle, mirroring
  `src/lib/ingestion/ingestionJobLifecycle.ts`'s pure/I-O split exactly.
  No retry/backoff logic exists here — `ai_jobs` has no
  `attempt_count`/`next_retry_at` columns yet, and none were added in
  this PR.
- **`runAiOperation.ts`** — the one generic orchestrator: creates the
  pending job, marks it running, calls the given `AiProvider`, validates
  the result, and persists success (job + result, one transaction) or
  failure (job only — `ai_results.structured_output` is `NOT NULL`, so a
  failed job correctly produces zero result rows). `confidence` and
  `reasoning` are accepted only as explicit, optional passthrough
  parameters (the same mechanism as `claimId`) — this function never
  inspects the validated structured output for a `confidence`- or
  `reasoning`-named property to populate those columns automatically.
  `structuredOutput` is always the complete, untouched validated
  operation output, independent of whatever `ai_results.confidence`/
  `ai_results.reasoning` end up holding. A future operation that wants
  those two columns populated (e.g. `recommendStatus`) maps its own
  output into them explicitly when it calls `runAiOperation` — PR 1
  leaves both `NULL` for every current generic execution, which is the
  intended behavior, not a gap.
- **`db/mutations/aiJobs.ts`** — the actual `ai_jobs`/`ai_results`
  reads/writes, operation-agnostic. No `requireAdmin()`/audit-log call
  here, same reasoning as `ingestionProcessor.ts`'s job claiming: this
  is an automated operation's own bookkeeping, not a live admin request.

**Provider strategy**: Anthropic is the only real provider implemented.
A test-only `FakeAiProvider` (`src/checks/helpers/fakeAiProvider.ts`)
implements the same `AiProvider` interface for checks — it is not
reachable as a production-configurable provider (no env var or registry
selects it; the only way to get one is to import the check-helper file
directly, which no application code outside `src/checks` does).

**`ai_job_status` has no separate value distinguishing a provider-side
failure from a structured-output validation failure** — both land in
`'failed'`, with the distinction preserved in `ai_jobs.error`'s text
(prefixed `provider_error:` or `invalid_structured_output:`). This was a
deliberate choice to avoid an unnecessary schema addition for PR 1.

**`ai_jobs.cost_estimate_usd` is passive persistence only in this PR** —
`runAiOperation`/`aiJobLifecycle.ts` will format and store an explicitly
supplied estimate, but nothing here computes one from token counts or
a pricing table. Provider/model pricing, budget enforcement, and any
cost-based routing are explicitly Phase 5 PR 2's territory.

**`detect_duplicates`** was added as its own `ai_operation` value
(migration `0013`) rather than folded into `compare_claims` — Phase 4
already performs deterministic/exact duplicate detection at ingestion
time; this reserves a distinct, independently observable operation for
the future *semantic* near-duplicate detection Phase 5 PR 6 will add
(jobs, costs, retries, and provider/model comparison all need to be
attributable to that operation specifically, not lumped into general
claim comparison).

No application code in this PR calls `runAiOperation()` from ingestion,
classifies any real source item, extracts any claim, or writes any
`ai_results` row from real model output — Phase 5 PR 1 is the execution
primitive only; every real operation is a later PR.

### AI cost controls & kill switch (Phase 5 PR 2)

`src/lib/ai/safety/` adds the mandatory safety checkpoint every call to
`runAiOperation()` passes through, between job creation and the actual
provider invocation — this is the single central enforcement boundary;
no future operation (`classifyRelevance`, `extractClaims`, ...) needs to
remember to check a budget or kill switch itself.

- **`killSwitch.ts`** — `isKillSwitchEngaged()`. `AI_KILL_SWITCH_ENGAGED`
  unset or exactly `"false"` means disengaged (normal operation, the
  opposite default direction from most config in this project, since this
  is an override switch, not a mandatory credential). Any other value
  engages it — ambiguity favors stopping for an emergency switch. Applies
  uniformly to every `AiProvider`, including the test-only fake provider,
  deliberately: distinguishing "real" from "test" execution would require
  providers to self-report their own billability, a weaker, spoofable
  signal than a single provider-agnostic guard.
- **`pricing.ts`** — a static map of per-model prices, in integer
  **micro-USD per million tokens** (a `bigint`, e.g. `3_000_000n` for
  $3.00/MTok) — a direct, exact transcription of Anthropic's published
  rate card, verified against `platform.claude.com/docs/en/about-claude/
  pricing` at authoring time. `calculateCostMicros()` computes exact
  BigInt cost with **no floating-point arithmetic anywhere** — token
  counts and prices are both integers, multiplied and summed as BigInt,
  then divided by `1_000_000n` (BigInt integer division, which truncates
  toward zero). That final division is the one place a sub-micro-USD
  remainder can exist (e.g. 7 tokens at a hypothetical $0.30/MTok rate is
  a true cost of 2.1 micro-USD, unrepresentable at the `numeric(10,6)`
  storage scale) — the remainder is deliberately truncated (floored), a
  documented, bounded-negligible choice (under $0.000001 per call) rather
  than a silent one. An unknown/unpriced model **fails closed** — the
  call is blocked before the provider is ever invoked, not silently
  allowed through with an unmeasured cost, since that would make the
  model's spend permanently invisible to the ceiling below.
- **`budget.ts`** — `AI_MONTHLY_BUDGET_USD` is **mandatory** (there is
  deliberately no "unset means unlimited spend" fallback: PR 2 exists
  specifically to establish the spend-safety boundary before automated AI
  execution begins, so forgetting to set this variable must fail closed,
  not silently disable the primary cost safeguard) and, once configured,
  a **soft, preflight** monthly spend threshold — explicitly NOT a hard
  or concurrency-safe ceiling. It only checks whether spend already
  recorded in `ai_jobs` (summed over the UTC calendar month, across every
  job status, since a failure that still reached the provider is still
  billable) has reached the configured amount. Two distinct overrun
  mechanisms follow from that, both documented in the file's header: (1)
  a **single-call overrun** exists even with one caller and zero
  concurrency, since the cost of the call being admitted is unknowable
  until the provider responds; (2) **concurrency** compounds this, since
  multiple simultaneous callers can each observe "not yet over the
  ceiling" before any of their cost is recorded. A hard, concurrency-safe
  reservation ledger would close both gaps but is deliberately deferred —
  Phase 5 PR 2 excludes ingestion-triggered/batched AI execution, so
  there is no concurrent caller yet to justify that complexity; build it
  when a future PR actually introduces one. An absent value throws
  `MissingAiBudgetConfigError`; an empty, negative, or otherwise
  unparseable value throws `MalformedAiBudgetConfigError` — neither ever
  silently becomes "no limit." `"0"` is a valid, accepted value: it
  parses to a ceiling of exactly 0 micro-USD, which (compared against a
  month-to-date spend that is always >= 0) blocks every single AI call
  once evaluated, with no special-cased "zero means off" branch anywhere
  in this file or in `evaluateAiSafety.ts`.
- **`money.ts`** — the shared exact-arithmetic primitives:
  `microsToUsdString()`/`parseUsdStringToMicros()`, both `bigint`-based,
  used by every other file in this directory. No `number`, `parseFloat`,
  or `.toFixed()` participates in any cost or budget calculation anywhere
  in `src/lib/ai/safety/`.
- **`evaluateAiSafety.ts`** — the single function `runAiOperation()`
  calls: kill switch, then unpriced-model, then month-to-date spend (now
  unconditional, since a budget ceiling is always resolved), in that
  order. Returns a typed `{allowed: true, pricing}` or `{allowed: false,
  reason, message}` — never throws for an ordinary, expected operational
  outcome. The two things that DO throw are a missing or malformed
  `AI_MONTHLY_BUDGET_USD` (`MissingAiBudgetConfigError` /
  `MalformedAiBudgetConfigError`), and `runAiOperation()` deliberately
  resolves that value **before** creating the `ai_jobs` row (the same
  "resolve config, then create the job" ordering already used for
  `getDefaultModel()`) — so neither ever strands a dangling `pending`
  row; no row is created for either case at all. The three ordinary
  blocked outcomes (kill switch / unpriced model / budget exceeded,
  including a `"0"` ceiling) are evaluated strictly after job creation
  but before `markAiJobRunning()`, and are recorded straight `pending →
  failed` — deliberately skipping `running`, since no provider call was
  attempted, and persisting no cost, since nothing was spent.

`aiJobLifecycle.ts`'s `buildFailurePatch` and `db/mutations/aiJobs.ts`'s
`completeAiJobFailure` were extended (not replaced) in this PR to accept
an optional `costEstimateUsd` — PR 1 only supported persisting cost on
the success path, but a failure that still reached the provider (e.g.
`invalid_structured_output`) is still billable, and omitting its cost
would have made the monthly budget systematically undercount real spend.

### Relevance classification (Phase 5 PR 3)

The project's first real semantic AI operation
(`src/lib/ai/operations/classifyRelevance.ts`), answering exactly one
question: is a stored source item relevant to the GTA VI claim-tracking
domain? This is advisory metadata and workflow state, never historical
truth — an `'irrelevant'` classification never deletes, hides, or
suppresses the underlying source item. Output is a small schema
(`relevance: relevant | irrelevant | needs_review`, `confidence`,
`reasoning`), with `confidence`/`reasoning` deliberately left `NULL` on
`ai_results` (the model-produced values live inside
`structured_output` instead, same reasoning `runAiOperation` already
documents for any caller that doesn't have its own value to pass in
before the call).

The system prompt tells the model that the retrieved URL/title/excerpt
are untrusted, retrieved content to be evaluated — never instructions
to obey. This is the first concrete application of the prompt-injection
defense Section 13 requires: source content is treated as untrusted
data, never as instructions the model should follow.

`src/lib/ai/operations/classificationTrigger.ts` is the one place that
selects the real Anthropic provider and loads the source item's fields;
it's called from exactly two sites — the synchronous post-ingestion-
confirmation trigger, and the admin recovery action for a missing/
stale/failed classification — both calling the same `classifyRelevance`
function so both paths share the same operation logic. `provider` is
injectable (defaults to the real provider) so checks can exercise this
exact orchestration path with `FakeAiProvider`.

### Claim extraction (Phase 5 PR 4)

`src/lib/ai/operations/extractClaims.ts` mirrors PR 3's execution/
orchestration pattern and shared AI safety controls, answering: what
standalone, atomic claim propositions are actually grounded in this
stored title/excerpt? This is a **proposal only** — nothing in this file or its callers writes to
`claims`/`evidence`/`claim_sources`; materializing an accepted candidate
into a real claim is PR 5's job.

Output is zero-to-many candidates (capped at `MAX_EXTRACTED_CLAIMS = 8`),
each with `statement`, `informationType`,
`supportingExcerpt`, `confidence`, and `reasoning`. Two constraints are
enforced programmatically, not just requested in the prompt: (1)
`supportingExcerpt` must be an exact, case-sensitive literal substring
of the supplied title or excerpt — a paraphrase or fabrication fails
Zod validation and surfaces as a normal `invalid_structured_output`
failure, not a silently-accepted row; (2) exact-duplicate candidate
statements (after whitespace/case normalization) are rejected. An empty
`claims` array is a normal, valid outcome — the model is explicitly told
not to force a claim to fill the list. Semantic near-duplicate detection
against *existing* claims is deliberately out of scope here; that's PR
6's job. `confidence`/`reasoning` are left `NULL` on `ai_results` for the
same reason as `classify_relevance` — each candidate carries its own,
and no single aggregate value would honestly represent them.

`src/lib/ai/operations/extractClaimsTrigger.ts` adds the one thing PR 3's
trigger never needed: an eligibility gate. Extraction only proceeds if
the source item's **latest successful** `classify_relevance` result is
exactly `'relevant'` — checked before any `ai_jobs` row is created or
provider call made, a hard backend gate, not just a UI convenience (the
review page also hides the action, but that's belt-and-braces).

### Extraction quality tightening and officialBasis (Phase 6 PR-B)

Production review of Phase 5 PR 4 extraction surfaced four recurring
low-value proposal patterns: personnel/job-title metadata offered as if
it were a claim, interview/publication/premiere logistics with no
substantive GTA VI assertion, generic "X discussed Y" statements, and
vague/non-trackable propositions (e.g. "there is a technical issue
affecting GTA VI" with no named system or problem). `SYSTEM_PROMPT` now
carries explicit omission rules for each pattern, a specificity/
trackability floor, and a neutral-canonical-wording rule (avoid
sensational language, unsupported causality, and certainty stronger than
`informationType` supports; word third-party reports as reports). Every
omission rule is paired with an explicit substantive-content carve-out —
a claim revealed through an interview, tied to a personnel change, or
connected to an event remains valid if it independently asserts a
specific, trackable GTA VI proposition — so the tightening filters
low-value context without suppressing genuinely unusual but significant
claims. None of this touches the programmatically-enforced constraints
(`supportingExcerpt` literal-substring grounding, exact-duplicate
rejection, empty-`claims[]`-is-valid) — those are unchanged, and are
independent of `statement`'s wording: neutralizing `statement` cannot
weaken `supportingExcerpt`'s grounding check, since the two fields serve
different jobs (canonical wording vs. evidence pointer).

**`officialBasis` — proposal-only advisory metadata, not provenance.**
Each candidate now also carries `officialBasis`, one of
`"direct_official_material"`, `"reported_official_material"`, or
`"not_applicable_or_unclear"`. This exists to help a human reviewer
notice when a candidate's underlying material appears to be official
Rockstar/Take-Two content, and — critically — whether *this one source
item* appears to BE that material or merely be reporting/relaying it:

- `direct_official_material` — the source item itself is first-party
  material (an official Rockstar Newswire post, an official Rockstar/
  Take-Two account post, a Take-Two investor release/filing, an
  official press release hosted by the first party). Reproducing,
  embedding, or quoting official material does **not** itself qualify —
  the item must BE first-party material, not merely contain some.
- `reported_official_material` — the source item is third-party
  material that reports, summarizes, embeds, quotes, reproduces, or
  otherwise relays first-party material (an outlet reporting on a
  Rockstar announcement, quoting an official statement, embedding an
  official trailer, summarizing a filing).
- `not_applicable_or_unclear` — not based on official material at all,
  or the given source identity/text don't allow a safe distinction. The
  model is explicitly told to prefer this value over guessing.

This is **advisory only**, exactly like every other candidate field:

- There is **no `claims` column for it** — `officialBasis` lives
  exclusively inside `ai_results.structured_output` JSON, never
  materialized onto the `claims` table. `approveClaimProposalSchema`
  has no `officialBasis` field, and `approveClaimProposal`'s `claims`
  insert has no path that could write it even accidentally.
- It is **not a provenance conclusion**. It describes only what this
  one source item's own identity/wording suggests about itself — never
  an origin/independence/corroboration judgment across multiple source
  items, which remains exclusively `source_relationships`/
  `analyse_provenance`'s job (see "Provenance: `source_relationships`"
  above). `extract_claims` sees exactly one source item at a time and
  has no cross-source visibility to support a stronger claim than that;
  the prompt explicitly tells the model never to imply an origin/
  independence/corroboration conclusion.
- It has **no effect on approval, status, or duplicate-detection
  semantics**. A `claimProposalReview.check.ts` mutation-boundary check
  proves this directly: two otherwise-identical proposals differing
  only in `officialBasis`, approved with the same human-submitted
  `informationType`, produce identical persisted claims; a human
  reviewer's `informationType` submission always wins over the AI's own
  proposed value, exactly as it already did before this PR.
- The admin review UI (`CandidateDetail.tsx`) surfaces it as a small,
  clearly-labeled note ("Official basis (AI note, not provenance): …")
  next to the existing `informationType` tag, never merged with it.

**Source-identity input (query change, no schema/migration impact).**
Classifying `officialBasis` well needs to know what the source item
*is*, not just infer it from the item's own raw URL text. `sources.name`
and `sources.homepageUrl` already exist and are admin-curated
(`createSource`/`updateSource`, `requireAdmin("editor")`-gated) — a more
trustworthy identity signal than scraped URL text. `extractClaimsTrigger`'s
query, `getSourceItemForClaimExtraction()`, now does a read-only join
from `source_items` to `sources` and passes `sourceName`/
`sourceHomepageUrl` through to `ExtractableSourceItem` and into the user
prompt as explicit, clearly-labeled classification context ("Source
identity … NOT a provenance/originality/independence conclusion"). This
is a read-only query change: no new column, no migration, no mutation
change. The item's own `url`/`title`/`excerpt` are still passed
unchanged alongside it.

**Backward compatibility.** `officialBasis` is required on every *new*
extraction response (the model must make the call, including the
explicit non-answer `not_applicable_or_unclear`) but is read as
*optional* everywhere `ai_results.structured_output` is read back
(`ExtractedClaimCandidate`, `listSourceItemExtractionStatus`'s defensive
shape-check). `structured_output` is `jsonb NOT NULL` with no DB-enforced
shape, so a historical row written before this PR simply lacks the key
entirely — a normal, valid state, not a data or parse error. A
regression check (`aiExtractClaims.check.ts`) constructs a synthetic
pre-PR-B-shaped row directly (bypassing `extractClaims()`) and proves
the admin read path still returns it correctly with `officialBasis`
undefined.

**Display-only tolerance was not enough — a second, dedicated fix was
needed for the review/action path.** `getExtractionCandidate()`
(`claimProposalReviews.ts`) — the single shared read used by
`approveClaimProposal`, `rejectClaimProposal`,
`resolveProposalAsExistingClaim`, and `detectDuplicatesTrigger.ts`'s
`triggerDetectDuplicates` — re-validates a candidate's *persisted*
`structured_output` using extract_claims' own Zod schema before any of
those actions can proceed. Pointing that re-validation at the same
strict schema used for fresh provider output would reject every
historical candidate's `officialBasis`-less shape outright, collapsing
`parsed.success` to `false` and making `getExtractionCandidate()` return
`null` — indistinguishable from "this aiResultId/candidateIndex doesn't
exist." A pre-PR-B unresolved candidate would still *display* normally
in the review list (that query never used this schema), but every
actual action on it — approve, reject, link-to-existing-claim, and
triggering a duplicate check — would fail as if it had vanished, with no
indication that `officialBasis` was the cause.

The fix: `extractClaims.ts` factors its schema construction into one
shared internal builder parameterized by whether `officialBasis` is
required, so the strict and tolerant variants cannot drift apart on
anything else. `buildExtractClaimsOutputSchema` (unchanged name/
behavior) stays strict — required `officialBasis`, used exclusively to
validate a fresh provider response, in `extractClaims()`/
`anthropicProvider.ts`. A new `buildPersistedExtractClaimsOutputSchema` —
identical in every other respect (`supportingExcerpt`'s literal-substring
grounding, exact-duplicate rejection, `claims[]`'s max length,
`noExtractableClaimsNote`'s constraint, every field's own length/range
limits) — makes `officialBasis` optional, and is used exclusively by
`getExtractionCandidate()` to re-validate already-persisted output. A
missing `officialBasis` is tolerated; an invalid (present-but-out-of-
enum) value is still rejected by both schemas identically — the
tolerance is specifically for legacy *absence*, not for genuinely
malformed data. `ProposalContext.candidate`'s type follows the same
split (`PersistedExtractClaimsOutput` in place of `ExtractClaimsOutput`);
none of `getExtractionCandidate()`'s four callers read `.officialBasis`
from the parsed candidate at all (only `.statement`/`.supportingExcerpt`
for provenance and duplicate-retrieval purposes), so this carries no new
authority or behavior change downstream. Regression checks in
`claimProposalReview.check.ts` and `detectDuplicatesOrchestration.check.ts`
construct genuinely legacy-shaped fixtures (no `officialBasis` key at
all, not merely `undefined`) and prove all four actions succeed against
them, not merely that they display.

The output-token bound (`EXTRACT_CLAIMS_MAX_OUTPUT_TOKENS`) moved from
3,584 to 3,840, recomputed from the schema's new worst case with
`officialBasis` included — see the constant's own doc comment in
`extractClaims.ts` for the full arithmetic. Still below the platform's
flat 4,096 default.

### Extracted-claim review (Phase 5 PR 5)

`extract_claims` produces one immutable `ai_results.structured_output`
document containing zero or more candidates. A single `admin_decisions`
row can identify that parent result, but cannot identify one candidate
within it. `claim_proposal_reviews` therefore records an immutable,
database-unique `(ai_result_id, candidate_index)` bridge to the human
decision and—only for an approval—the newly created `claims` row.

The review mutation re-reads and validates the stored extraction result
against the actual source item's title/excerpt. It does not accept a source
item id or supporting quotation from the browser. An approval is one
transaction: it creates the claim, optional topic links, a single
`claim_sources` row with that persisted quotation, the approval decision,
both initial status-history rows, the proposal-review bridge, and the
append-only general audit entries. A rejection creates only its decision,
proposal-review row, and audit entry—never a claim, evidence record, or
provenance link. Neither action invokes an AI provider.

The reviewer may amend claim metadata and choose both initial statuses. The
UI defaults conservatively to `unverified` and `unknown`; an official source
does not silently imply `confirmed`. Candidate reviews are append-only: a
mistake is handled by subsequent normal claim administration, not by
erasing the record of the original human decision. Semantic matching to an
existing claim remains deliberately out of scope for this PR; Phase 5 PR 6
owns near-duplicate analysis.

### Semantic duplicate detection (Phase 5 PR 6)

`detect_duplicates` checks one persisted, **unreviewed** `extract_claims`
candidate against a bounded set of existing claims for a genuine
near-duplicate — the same underlying atomic proposition, not merely the
same topic or entity. Like every other AI operation in this project, it is
advisory only: nothing in `detectDuplicates.ts`/`detectDuplicatesTrigger.ts`
ever writes to `claims`, `claim_sources`, `claim_relationships`, or either
status-history ledger. `compare_claims` remains a separate, still-unused
operation — its own home in a future PR is not decided here.

**Candidate identity and eligibility.** A candidate is identified exactly
the way PR5's `claim_proposal_reviews` already does —
`(ai_result_id, candidate_index)` — re-read and re-validated from the
persisted `extract_claims` result on every call, never trusted from a
form. A candidate that has already been reviewed (approved, rejected, or
resolved to an existing claim) is ineligible for a **new** duplicate
check, retry, or recovery attempt — checked before any retrieval work,
before any `ai_jobs` row is created, and before any provider call, so a
reviewed proposal produces zero new job rows and zero AI spend. A job
that was already in flight when a candidate became reviewed is left
completely alone; it is never cancelled, and its eventual result remains
valid historical advisory data.

**Retrieval is tiered and cost-bounded**, using two constants in
`detectDuplicatesTrigger.ts`: at or below
`DUPLICATE_CHECK_ALL_CLAIMS_THRESHOLD` (30) existing claims, every claim
is sent to the model; above it, existing claims are ranked by `pg_trgm`
lexical similarity (`extensions.similarity(...)`, migration `0017`) and
only the top `DUPLICATE_CHECK_PREFILTER_LIMIT` (20) are sent — this keeps
the AI call's input size, and therefore its cost, flat regardless of
whether the claims table has 100 or 10,000 rows. No trigram index backs
this query in this PR — a sequential scan is fast at this project's
current scale, and adding one now would be premature. If the retrieval
set is empty, **no `ai_jobs` row is created and no provider is called** —
`triggerDetectDuplicates` returns a distinct `no_existing_claims` outcome,
the same "ineligible, stop before any job row exists" shape
`extractClaimsTrigger.ts` already uses for its own eligibility gate.

**IMPORTANT, current architectural limitation: duplicate detection is
scoped to project 1 only, not genuinely project-aware.** `source_items`/
`sources` carry no `project_id` in this schema — only `claims.projectId`
does, and that value is chosen by a human at **approval** time (see
`approveClaimProposal`'s `data.projectId`), never derivable from a source
item or an unreviewed extraction candidate. The schema itself does
structurally support multiple projects (`claims.projectId`,
`topics.projectId`, and their per-project unique indexes), and nothing at
the database level enforces exactly one project row — but every existing
admin write path that creates a claim already hardcodes the identical
literal project id `1`, with zero project-selector UI anywhere in this
application (`src/app/admin/(protected)/claims/new/page.tsx`,
`review/page.tsx`'s approve form, and `topics/page.tsx`). PR6's
`DUPLICATE_CHECK_DEFAULT_PROJECT_ID = 1` constant in
`detectDuplicatesTrigger.ts` matches that existing convention rather than
inventing a different one — retrieval unscoped by project would have made
PR6 the only place in the codebase behaving inconsistently with every
sibling admin mutation. `triggerDetectDuplicates` and
`getDuplicateCheckRetrievalSet` both accept an optional `projectId`
parameter (defaulting to that constant) purely so this exact limitation
can be proven deterministically in a check, against a genuinely isolated,
empty project — no production or admin code path ever supplies that
argument explicitly, and no browser-submitted project id is ever
accepted. **Before this product becomes genuinely multi-project**, a real
source-item/project association must be added (and, with it, all four
hardcoded `"1"` literals replaced by an actual project-selection
mechanism) — this PR deliberately does not build that association.

**AI output contract.** The output schema is parameterized, per call, by
the exact set of existing-claim ids actually offered to the model —
mirroring `extractClaims.ts`'s own "schema built fresh from the real
input" pattern. A returned `existingClaimId` outside that exact set fails
Zod validation inside the provider before `runAiOperation` ever returns
success, surfacing as a normal `invalid_structured_output` failure with
zero `ai_results` rows — the model can never fabricate a match. At most
`MAX_DUPLICATE_MATCHES` (5) matches are returned, each with a `confidence`
(0–1) and bounded `reasoning`; duplicate `existingClaimId` values within
one result are rejected; an empty `matches` array (optionally with a
`noLikelyDuplicateNote`) is a normal, successful "no likely duplicate"
outcome, not a failure. `DETECT_DUPLICATES_MAX_OUTPUT_TOKENS` (768) is
derived directly from this schema's own worst-case size, the same
justification style `EXTRACT_CLAIMS_MAX_OUTPUT_TOKENS` used. The prompt
defines "duplicate" narrowly and explicitly forbids relationship
vocabulary (`refines`/`contradicts`/`subsumes`/`related`) — those concepts
belong to a separate, later operation, not this one.

**Persistence and concurrency.** `ai_jobs` gained a second, narrower
scoped identity alongside `source_item_id`: `extraction_ai_result_id` /
`extraction_candidate_index` (migration `0018`), populated only for
`operation = 'detect_duplicates'` and enforced both directions by one
combined `CHECK` constraint (`ai_jobs_detect_duplicates_operation_
consistency`) rather than two separate ones — a candidate either has both
fields populated (when its operation is `detect_duplicates`) or neither
(every other operation). A partial unique index on that same pair, scoped
to `pending`/`running` rows, is the in-flight concurrency guard —
`createPendingAiJob()`'s existing generic unique-violation handling covers
it automatically, no new code needed. `extraction_ai_result_id` uses an
explicit `ON DELETE RESTRICT` FK to `ai_results.id` (this project's other
FKs rely on the implicit default, behaviorally identical for a
non-deferred constraint — this one is just explicit about intent).
Recovery (`detectDuplicatesRecovery.ts`) mirrors
`extractClaimsRecovery.ts` exactly — the same plain, blocking `FOR UPDATE`
targeted-row lock (never `SKIP LOCKED`, since exactly one candidate is
targeted, nothing to skip to) — with the reviewed-proposal eligibility
gate checked *before* the lock is acquired, so a genuinely stale in-flight
job for an already-reviewed candidate is left completely untouched rather
than reclaimed.

**The "Use existing claim" human resolution.** When an admin agrees a
candidate is the same fact as an existing claim,
`resolveProposalAsExistingClaim` (`claimProposalReviews.ts`) attaches the
candidate's source/excerpt as provenance to that **existing** claim
instead of creating a new one — one atomic transaction, mirroring
`approveClaimProposal`'s shape but skipping the claim/topic/status-history
inserts entirely, since attaching a new source must never silently
reinterpret an already-settled claim's status. All five correctness
checks — the candidate still resolves from the persisted extraction, the
proposal is still unreviewed, the submitted `existingClaimId` genuinely
appears in this exact candidate's own latest successful persisted
`detect_duplicates` result, and the existing claim still exists — are
re-verified from *within* that same transaction, never trusted from a
prior read or a browser-submitted value beyond using it as a lookup key.
`claim_sources_unique` (migration `0000`) is on `(claim_id, source_item_id)`
only, so `insertClaimSourceLinkTx` (`claimSources.ts`) uses `INSERT ...
ON CONFLICT DO NOTHING` — deliberately, not a caught unique-violation
exception, since the latter would poison the rest of the same Postgres
transaction — and treats an already-existing link as idempotent success,
**never** overwriting its existing `stance`/`supportingExcerpt`. This
primitive is typed to accept only a real transaction handle
(`DbTransaction`, not the wider `DbExecutor` other read helpers accept),
so the type system — not just a comment — prevents it from ever being
called outside an existing atomic transaction. The resolution is recorded
with a dedicated `admin_decisions.action` value, `link_existing_claim`
(migration `0019`, isolated in its own `ALTER TYPE ... ADD VALUE` per this
project's own convention for enum additions) — `claim_proposal_reviews.
materialized_claim_id` needed no schema change at all, since it was
already a plain nullable FK to `claims.id` with no constraint tying it to
any specific decision action (confirmed by direct inspection of migration
`0016`). The existing one-review-per-candidate unique index remains the
final race barrier: two concurrent terminal decisions on the same
candidate (approve-new vs. use-existing, reject vs. use-existing, or two
concurrent use-existing attempts) always resolve to exactly one winner,
with the loser's entire transaction — including any source link it had
just inserted — rolled back atomically.

### Claim relationship analysis (Phase 5 PR 7)

`compare_claims` compares one **existing** "focus" claim against a bounded
shortlist of other existing claims in the same project and recommends
whether any of them stands in one of the five `claim_relationships` types
to it — `equivalent`, `subsumes`, `refines`, `contradicts`, `related`.
This is deliberately **not** `detect_duplicates`: PR6 answers "does this
just-extracted, unreviewed candidate already exist as a claim"; PR7
answers "how do these two already-tracked claims relate to each other."
One call compares the focus claim against its whole shortlist and returns
zero-to-several assessments — never one call per pair, which is what
keeps the cost model flat regardless of how large the claims table grows
(see "Retrieval" below). Assessments are **positive-only**: the model
reports a claim only when it found a genuine relationship, with an
optional `noRelationshipNote` when it explicitly found none; there is no
per-candidate "none" verdict, which would roughly double worst-case
output size for no real benefit.

**Directional semantics.** `equivalent`, `contradicts`, and `related` are
symmetric and carry no `direction` field — canonicalized at write time
exactly like PR6's manual relationship form (lower numeric claim id
always stored as `claim_id_a`). `subsumes` and `refines` are directional
and **require** a `direction` field: `"focus_to_other"` means the focus
claim does the subsuming/refining; `"other_to_focus"` means the other
claim does. This is enforced structurally, not just by prompt wording —
`buildCompareClaimsOutputSchema`'s `superRefine` (in `compareClaims.ts`)
rejects a `direction` on any symmetric type and requires one on either
directional type, importing the same `DIRECTIONAL_RELATIONSHIP_TYPES` set
`relationshipCanonicalization.ts` already uses for the write path, so the
schema and the eventual database write can never silently disagree about
which types are directional.

**AI never automatically mutates the claim graph.** Like every other AI
operation in this project, `compareClaims()`/`compareClaimsTrigger.ts`
never write to `claim_relationships`, `claims`, or either status-history
ledger. The only path from a recommendation to an actual
`claim_relationships` row is an admin's explicit approval — approve
as-proposed or approve-with-changes — via
`claimComparisonReviews.ts`; a rejected or never-reviewed assessment
leaves the claim graph completely untouched. The audit chain is `ai_jobs`
(the provider call and its cost/token accounting) → `ai_results` (the
persisted structured output, all assessments for that call) →
`admin_decisions` (the human's approve/edit/reject verdict) →
`claim_comparison_reviews` (the append-only bridge tying one specific
assessment within that result to that decision, plus — for an approval —
an immutable snapshot of the relationship that resulted). This mirrors
`claim_proposal_reviews`' role for PR5 exactly: `admin_decisions.
ai_result_id` identifies a whole result, not one assessment within it, so
a dedicated bridge is what makes "which of the up-to-six assessments was
this decision about" answerable at all.

**Focus-claim identity and eligibility.** Unlike PR6's candidate identity
`(extraction_ai_result_id, extraction_candidate_index)`, PR7 is scoped to
one **existing claim**: `ai_jobs.comparison_claim_id` (migration `0021`),
populated only for `operation = 'compare_claims'` and enforced both
directions by one combined `CHECK` constraint
(`ai_jobs_compare_claims_operation_consistency`), the same "populated iff
this operation, null otherwise" shape as PR6's own consistency check. A
partial unique index on that column, scoped to `pending`/`running` rows,
is the in-flight concurrency guard, requiring no new application code
beyond `createPendingAiJob()`'s existing generic unique-violation
handling. Because the `compare_claims` enum value had already been used
as an arbitrary, unconstrained fixture value by
`aiRunOperation.check.ts` prior to this PR, migration `0021` opens with an
explicit pre-flight `DO` block that counts any pre-existing
`ai_jobs` row with `operation = 'compare_claims'` and raises with an
actionable message rather than failing on an opaque constraint violation
if one is found; that check's own fixture was swapped to the operation
`embed` for exactly this reason (see that file's own header comment).

**Retrieval is project-scoped, tiered, and cost-bounded** — and, unlike
PR6, **genuinely** project-aware rather than hardcoded: the shortlist is
scoped by the focus claim's own `claims.projectId`, read from the
database, with no equivalent of PR6's
`DUPLICATE_CHECK_DEFAULT_PROJECT_ID` literal anywhere in this operation.
The shortlist always excludes the focus claim itself and any other claim
already linked to it by an existing `claim_relationships` row in
**either** direction — a settled pair does not need AI re-analysis (PR7
does not yet support multi-type relationships between the same pair or
re-analysis semantics; that is deferred). At or below
`COMPARE_CLAIMS_ALL_CLAIMS_THRESHOLD`/`COMPARE_CLAIMS_MAX_CANDIDATES`
(12) comparable claims, every one of them is sent to the model; above
that, they are ranked by `pg_trgm` lexical similarity
(`extensions.similarity(...)`, the same `pg_trgm` extension migration
`0017` enabled for PR6) and only the top 12 are sent. Unlike PR6, this
single constant bounds **both** the input size and the worst-case output
size — a `compare_claims` call's output scales with how many candidates
it was offered, unlike `detect_duplicates`' fixed-size `matches` array, so
one shared cap does both jobs here where PR6 used two separate constants
(`..._ALL_CLAIMS_THRESHOLD` for input, `..._PREFILTER_LIMIT` for a
different input concern). If the shortlist is empty, **no `ai_jobs` row
is created and no provider is called** — `triggerCompareClaims` returns a
distinct `no_comparable_claims` outcome, the same "ineligible, stop
before any job row exists" shape PR6's `no_existing_claims` outcome uses.

**IMPORTANT, known and accepted retrieval limitation: above the
threshold, ranking is purely LEXICAL, not semantic.** A near-duplicate (PR6's
concern) almost always shares vocabulary with the claim it duplicates, so
lexical ranking is a reasonable proxy there. A genuine **contradiction**
need not share vocabulary at all — "the protagonist duo splits partway
through the story" and "Lucia and Jason remain playable together for the
entire campaign" directly contradict each other with minimal trigram
overlap, and the second would not be shortlisted for the first once a
project exceeds 12 claims. The same applies to `subsumes`/`refines` pairs
phrased at very different levels of abstraction, and to `related` pairs
that describe the same underlying topic in unrelated vocabulary. The
consequence is **false negatives only** — a real relationship that is
never surfaced — **never false positives**, since every surfaced
recommendation still requires human approval before it can affect the
claim graph; a small or empty `assessments` array is therefore not proof
that a claim has no relationships. PR7 deliberately does **not** attempt
to solve this with embeddings: `ai_operation` already carries an unused
`embed` value, and semantic retrieval is properly scoped to the future
Autonomous Web Discovery phase, when claim volume actually makes it
necessary and provides real data to tune it against — adding a `pg_trgm`
index or an embedding-based retrieval path now, on a table with double-
digit rows, would be premature optimization.

**AI output contract.** The output schema (`buildCompareClaimsOutputSchema`
in `compareClaims.ts`) is parameterized, per call, by the exact focus
claim and candidate-claim-id set actually offered — mirroring PR6's own
"schema built fresh from the real input" pattern. A returned
`otherClaimId` outside that exact set, or equal to the focus claim's own
id, fails Zod validation inside the provider before `runAiOperation` ever
returns success, surfacing as a normal `invalid_structured_output`
failure with zero `ai_results` rows. At most `MAX_COMPARE_CLAIMS_
ASSESSMENTS` (6) assessments are returned, each with a `relationshipType`,
an optional `direction` (required iff directional), a `confidence`
(0–1), and bounded `reasoning`; duplicate `otherClaimId` values within one
result are rejected. `COMPARE_CLAIMS_MAX_OUTPUT_TOKENS` (1,280) is
derived directly from this schema's own worst-case size (six assessments
at their maximum field lengths), the same justification style
`EXTRACT_CLAIMS_MAX_OUTPUT_TOKENS`/`DETECT_DUPLICATES_MAX_OUTPUT_TOKENS`
used. The prompt defines each of the five relationship types precisely
(in particular the `subsumes`/`refines` distinction and that
`contradicts` means the propositions cannot both be true, not merely that
they come from rival outlets) and explicitly instructs that returning
nothing is a normal, valid outcome — never force a weak `related` link to
fill the array.

**Display and recovery.** A focus claim's relationship-analysis status is
one of **six** display states, not the usual five: the shared job-status
five (`not_analysed`/`in_progress`/`stale`/`failed`/`succeeded`, this
operation's own vocabulary for the generic `missing` state used by every
sibling operation) plus a sixth, `no_comparable_claims`, computed
independently of job history from whether any comparable claim currently
exists at all (`relationshipAnalysisActionability.ts`). Exactly three
states are actionable — `not_analysed` ("Analyse relationships"), `stale`
("Recover"), `failed` ("Retry") — mirroring PR6's own three-of-six
actionable pattern. **`succeeded` offers no re-analysis action in this
PR** — a locked, deliberate restraint identical to PR6's own restraint
for `detect_duplicates`; graph-change-aware re-analysis (re-running a
comparison as new claims enter a project) is deferred to a later PR, once
Autonomous Web Discovery increases claim volume enough to make it a real
question. Recovery (`compareClaimsRecovery.ts`) mirrors
`detectDuplicatesRecovery.ts` exactly — the same plain, blocking `FOR
UPDATE` targeted-row lock (never `SKIP LOCKED`) — and, like every
trigger/recovery action in this project, writes **no** `admin_audit_log`
entries; only the eventual human review decision on a specific assessment
is audited.

**Review: approve, approve-with-changes, reject, and idempotent reuse.**
`claimComparisonReviews.ts` re-reads and re-validates the persisted
assessment on every review action — only the `otherClaimId` is accepted
from the browser, and purely as a tamper-check lookup key confirmed
against this exact assessment's own persisted output before anything is
written. Approval resolves the raw `(claimIdA, claimIdB)` orientation
from the focus claim, the other claim, and the assessment's direction,
then calls `insertClaimRelationshipTx` — a transaction-scoped primitive
extracted from `createClaimRelationship`
(`claimRelationships.ts`, this PR's one targeted refactor of existing
code; `createClaimRelationship`'s own public behavior, including throwing
`DuplicateRelationshipError`, is unchanged) — which applies
`canonicalizeClaimRelationshipPair()` and uses `INSERT ... ON CONFLICT DO
NOTHING` rather than a caught unique-violation exception, for the same
reason `insertClaimSourceLinkTx` does: a caught exception mid-transaction
would poison the rest of that Postgres transaction, and this approval has
further writes to make afterward. If the resolved relationship **already
exists**, the existing row is reused untouched — its own `confidence` and
`created_by` are never overwritten — and the bridge records
`relationship_was_newly_created = false`; **no** `create`/
`claim_relationship` audit entry is emitted for a reused relationship,
since nothing was actually created, while the `create`/
`claim_comparison_review` audit entry recording the human decision itself
is still written unconditionally. A genuinely new relationship gets both
entries. `claim_relationships.created_by` is always `'human'` for an
approved recommendation — the AI's own provenance is fully preserved via
`ai_jobs` → `ai_results` → `admin_decisions` → `claim_comparison_reviews`,
but the effective graph mutation only ever happens because a human
approved it. Approve-with-changes lets the admin override the
`relationshipType`/`direction` (never the counterparty claim — retargeting
at a different claim is a new relationship, and belongs in the existing
manual "Related Claims" form) and records `admin_decisions.action =
'edit'` instead of `'approve'`, so the audit trail distinguishes "the AI
was right" from "the AI was close." Rejection records a decision and a
bridge row with all five snapshot columns `NULL`, and creates zero
`claim_relationships` rows. The bridge's own unique index on
`(ai_result_id, assessment_index)` is the race barrier: two concurrent
reviews of the same assessment always resolve to exactly one winner, with
the loser's entire transaction — including any relationship row it had
just inserted — rolled back atomically.

**Immutable snapshot semantics.** `claim_comparison_reviews`
(migration `0022`) is append-only, protected by the same `reject_
status_history_mutation()` trigger every other immutable ledger in this
project uses. For an approval, its `approved_claim_id_a`/
`approved_claim_id_b`/`approved_relationship_type` columns are populated
strictly from the row `insertClaimRelationshipTx` **actually returned** —
after direction resolution and, for symmetric types, canonicalization —
never from the raw pre-resolution focus/other orientation; a database
`CHECK` (`claim_comparison_reviews_symmetric_snapshot_canonical`)
independently enforces that the stored snapshot is canonical for the
three symmetric types, rather than trusting application code to have done
it correctly. `materialized_relationship_id` is deliberately a **plain
integer, not a foreign key** to `claim_relationships.id`. Unlike claims
(never hard-deleted anywhere in this codebase, confirmed by direct
inspection), `claim_relationships` rows genuinely are deletable
(`deleteClaimRelationship`), and combined with this table's own
immutability trigger, no FK action is workable: `ON DELETE SET NULL`
would *update* this row, which the trigger rejects, making the
relationship effectively undeletable; `ON DELETE RESTRICT` would block a
legitimate deletion outright; `ON DELETE CASCADE` would destroy the very
historical record this table exists to keep. The accepted trade-off: a
deleted relationship leaves this column as a harmless dangling id — never
misleading, since Postgres serial sequences never reuse a value, and the
deletion itself remains fully audited via `admin_audit_log` — while the
four columns beside it are a complete, self-describing snapshot that
needs no dereference to remain meaningful on its own.

**Directional relationship display fix (in-scope prerequisite).** PR7
also fixes a pre-existing defect: `getRelatedClaims`
(`src/db/queries/claimDetail.ts`) matched a `claim_relationships` row for
the viewed claim without indicating which side of the stored
`(claim_id_a, claim_id_b)` pair it occupied, and neither the admin claim
page nor the public `RelatedClaims` component accounted for that side —
so roughly half of all directional (`subsumes`/`refines`) relationships
displayed with their meaning **inverted**, and the two consumers
additionally disagreed with each other (the public component always
rendered `refines` in the passive voice; the admin page always rendered
the raw enum value). `getRelatedClaims` now returns a `viewedClaimIsA`
flag per row, and both consumers call one shared pure function,
`relatedClaimLabel()` (`src/lib/relationshipDisplay.ts`), instead of
maintaining two independent label maps that could disagree again.

**Forward compatibility with Autonomous Web Discovery.** Four choices in
this PR are deliberate preparation for that future phase: (1) no
hardcoded project id anywhere in this operation (unlike PR6's
`DUPLICATE_CHECK_DEFAULT_PROJECT_ID`), so higher claim volume across a
genuinely multi-project future needs no rework here; (2)
`triggerCompareClaims`'s provider and shortlist bounds are injectable
parameters with server-side defaults, exactly like PR6's own trigger, so
a future batch worker can call the same trigger with its own values
without a rewrite; (3) the in-flight guard is scoped to one focus claim,
not a session or admin, so a future batch worker can hold `FOR UPDATE
SKIP LOCKED` over many focus claims concurrently without touching this
PR's own per-claim blocking recovery mutation, preserving the "`SKIP
LOCKED` is for batch workers only" convention rather than pre-empting it;
(4) the bridge's identity is `(ai_result_id, assessment_index)`, not
`(claim_a, claim_b)`, so when discovery repeatedly resurfaces a topic and
the same pair is analysed again months later, each recommendation stays
independently identifiable and independently auditable rather than
collapsing into one pair-keyed history.

### Provenance analysis (Phase 5 PR 8b)

`analyse_provenance` operates on one claim-anchored source-item cluster
(the source items linked to a claim via `claim_sources`, capped at 15) and
proposes directed edges over `source_relationships` distinguishing
citation, repetition, derivative, aggregation, independent corroboration,
and unknown provenance. Structurally this PR mirrors PR7's compare_claims
exactly (trigger + operation + recovery lifecycle + actionability + a
review bridge table), but with three deliberate divergences worth stating
explicitly.

**Divergence 1 — durable-row confidence/evidence policy.** PR7's
`insertClaimRelationshipTx` accepts and persists the human-approved
`confidence` value onto `claim_relationships` at approval time. PR8b's
`insertSourceRelationshipTx` does the opposite: `source_relationships.confidence`
and `.evidence_note` are **always** written as `NULL` from the review
path, regardless of what the AI proposed. The AI's own confidence,
reasoning, and (for `independent_corroboration`) `distinctEvidenceSummary`
remain fully readable via `ai_results.structured_output` and this PR's own
`source_relationship_reviews` bridge — nothing is lost — but none of it is
copied onto the durable graph row itself. This is a locked product
decision, not an oversight: provenance edges are treated as a stronger,
more consequential claim about the world (independent corroboration in
particular) than a claim-to-claim relationship, so the durable row
deliberately carries only what a human explicitly authored, never an
AI-originated number presented as if a human vouched for it. **PR7 itself
is unchanged by this PR** — its own confidence-materialization behavior on
`claim_relationships` remains exactly as PR7 shipped it.

**Divergence 2 — server-side supersession enforcement.** PR7's
`claimComparisonReviews.ts` mutations check only that the *named*
`ai_result_id`'s own job succeeded — not whether it is still the *latest*
succeeded `compare_claims` result for that focus claim (confirmed by
direct inspection during PR8b's implementation; **left unchanged in PR7**,
per explicit instruction — past behavior is not a defect this PR is
scoped to fix). PR8b's own locked requirement is stricter:
`sourceRelationshipReviews.ts` re-checks, from *within* each mutation's own
transaction, that the target `ai_result_id` is still the latest succeeded
`analyse_provenance` result for its anchor claim (`ORDER BY completed_at
DESC, id DESC`, matching every other "latest succeeded" query in this
codebase) before allowing an approve/edit/reject to proceed, throwing
`ProvenanceResultSupersededError` otherwise. Older results remain
preserved for audit; only their *unreviewed* edges become non-actionable
once a newer succeeded analysis exists.

**Divergence 3 — no canonicalization, ever.** `source_relationships` was
never canonicalized to begin with (see PR8a / `provenanceDirection.ts`),
so unlike `claim_comparison_reviews_symmetric_snapshot_canonical`, PR8b's
`source_relationship_reviews` bridge has no equivalent CHECK at all: `(A,
B, citation)` and `(B, A, citation)` are different facts and both may
coexist as independently approved rows, proven directly in
`sourceRelationshipReview.check.ts`.

Re-analysis is cluster-change-gated, not time- or claim-statement-gated: a
`provenance_cluster_fingerprint` (SHA-256 of the exact canonical
cluster-item payload sent to the model, deliberately excluding
`claims.statement` and any volatile metadata) is stored on `ai_jobs` at
call time, and the admin UI only offers "reanalyse" from a `succeeded`
state when the claim's *current* cluster fingerprint no longer matches
it.

### Structured-output bounded retry & admin recovery UI hardening (Phase 6 hardening)

Production verification of PR 6.2 surfaced two defects, both fixed
narrowly rather than with general-purpose machinery.

**Bounded automatic retry for `invalid_structured_output`.**
`runAiOperation()` (Phase 5 PR 1) now makes exactly one automatic retry —
two provider attempts maximum — but only when the failure reason is
`invalid_structured_output`. This absorbs ordinary model-side tool-call
flakiness (e.g. an array field occasionally emitted as a string) without
burning an admin's manual "Retry" click on something the model would
have gotten right a moment later.

- **Scope is deliberately narrow.** `provider_error`, every
  `AiSafetyBlockedReason` (kill switch, unpriced model, budget ceiling),
  and `already_in_flight` are never retried here — a real provider outage
  or a budget/kill-switch block retrying immediately would compound the
  problem, not fix it. Only a schema-validation failure is safe and cheap
  to retry once, immediately.
- **Synchronous and request-scoped, not a retry scheduler.** This is a
  single bounded in-request loop inside `runAiOperation()` — no delay, no
  queue, no new `attempt_count`/`next_retry_at` columns on `ai_jobs`. One
  `ai_jobs` row still represents the whole job regardless of how many
  provider round-trips it took to reach a terminal state — this is
  explicitly *not* the "retry scheduler" `aiJobLifecycle.ts`'s own header
  comment excludes from scope (that refers to an async, delayed,
  ingestion-style backoff mechanism; this is neither delayed nor async).
- **Token/cost accounting is summed across both attempts.** A failed
  first attempt can still have consumed real, billable tokens; those are
  never dropped. Whether the job ultimately succeeds (on the retry) or
  fails (both attempts invalid), the persisted `ai_jobs.tokens_in` /
  `.tokens_out` / `.cost_estimate_usd` reflect the total across every
  attempt, not just the last one.
- **A double failure truthfully records the retry.** If both attempts
  fail, the persisted `ai_jobs.error` text is suffixed `(after 1
  automatic retry)` — the audit trail never silently implies a single
  clean attempt when there were in fact two.
- **No change to AI advisory authority or human-review semantics.** This
  only affects whether a job succeeds in getting valid structured output
  from the model. It has zero effect on classification/extraction/
  duplicate-check/comparison/provenance recommendations still requiring
  the same explicit admin approve/reject/edit before anything is written
  to `claims`, `claim_relationships`, or `source_relationships`.

**Admin recovery UI: stale post-retry rendering.** The three admin
recovery server actions (`runClassificationRecoveryAction`,
`runExtractClaimsAction`, `runDetectDuplicatesAction` in
`src/app/admin/(protected)/review/actions.ts`) previously called
`revalidatePath("/admin/review")` once, before the actual mutating
`trigger...()` call ran — meaning the revalidation signal reflected
pre-mutation state, not the job's real outcome. Combined with a final
redirect URL keyed only on a coarse status word (e.g. `extractStatus=
failed`), a repeat status across two clicks could redirect to a
byte-identical URL to one already visited, risking a stale cached render
surviving until a manual browser refresh.

All three actions now:

- call `revalidatePath("/admin/review")` again, immediately before the
  final redirect, *after* the mutating operation has actually completed
  — so the invalidation reflects the true final state, not a snapshot
  from before the job ran;
- append the newly created job's own id to the redirect URL as a
  cache-busting parameter wherever one exists (real identity, not an
  arbitrary timestamp), guaranteeing the exact redirect target was never
  visited before. The one exception is `detect_duplicates`'
  `no_existing_claims` outcome, which never creates an `ai_jobs` row (no
  provider call is made), so there is no job id to key on there — that
  redirect target is unchanged.

The earlier `revalidatePath` call before the `fresh_in_flight` early-exit
branch (no mutation follows it in that branch) was already correctly
ordered and is unchanged.

### Outbound link observations: `source_item_links` (Phase 6 prerequisite)

Before Phase 6's autonomous discovery providers are built, this PR closes
a gap the ingestion pipeline had from Phase 4 onward: it fetched full HTML
but discarded every `<a>` tag, meaning `analyse_provenance`'s prompt could
never actually check whether one item's page linked to another's, despite
its own instructions describing exactly that kind of evidence
("...paragraph 2 links directly to the to item's URL"). `source_item_links`
closes that gap.

**`source_item_links` is a MECHANICAL OBSERVATION table, not an epistemic
conclusion table — this distinction must never be blurred.** It records
only deterministic, structural facts extracted from one fetch: that an
`<a>` tag existed, what URL it resolved to, where it sat in the DOM
(`placement`: `content` / `chrome` / `ambiguous`), whether its target was
same-site or cross-site, and the anchor text/nearby visible text. It
**never** asserts citation, derivative, repetition, or any other
relationship — there is deliberately no column shaped like
`is_citation`/`likely_citation` anywhere in this table. `source_relationships`
remains, exactly as it always has been, the **reviewed epistemic
conclusion** table: populated only by a human directly, or by AI proposal
(`analyse_provenance`) followed by mandatory human review
(`source_relationship_reviews`). A hyperlink observation is evidence to
weigh; a `source_relationships` row is a judgment that has actually been
made. Nothing in this PR's code path writes `source_relationships`
directly — `source_item_links` rows are read-only input to
`analyse_provenance`'s prompt and to the admin's own eyes, never a second,
implicit way to materialize a provenance edge.

**Observation vs. enrichment.** Every column except (`to_source_item_id`,
`resolved_at`) is fixed forever at insert time — the same "historical
information must not silently disappear or be overwritten" principle
governing every other table in this project. Exactly one transition is
permitted after insert: `to_source_item_id` may move from `NULL` to a real
id, exactly once, together with `resolved_at`, enforced by a **new kind of
trigger** for this codebase — `restrict_source_item_link_mutation()` is a
*partial*-immutability trigger (every other append-only table here uses a
blanket "reject every UPDATE/DELETE" trigger); this one permits exactly
the one legitimate transition and rejects everything else, including a
second resolution attempt, a no-op update, and any change to an
observation column. This is deliberately framed as *enrichment of a
previously-unknown pointer*, not a rewrite of what the HTML actually
contained.

**Unresolved links are intentionally retained, not noise.** A
freshly-fetched page overwhelmingly links to URLs this project hasn't
ingested yet — discarding those would throw away exactly the
forward-looking discovery signal later Phase 6 providers are meant to use.
Unresolved rows remain subject to the same
`MAX_EXTRACTED_LINKS_PER_JOB` (200) cap as everything else.

**Resolution is deterministic, exact-match-only, and never guessed.** A
link resolves to a `source_items` row if and only if **exactly one**
distinct id matches its `normalized_target_url` via the same dual-field
policy dedup already uses (`normalized_url OR canonical_url`, reusing
`findCandidateSourceItemsByUrl`'s identity policy, not a second
implementation). Zero matches, or more than one distinct match (the
"edited content re-ingested as a new row" case — `source_items.normalized_url`
is deliberately non-unique, so two rows can legitimately share a URL),
both leave the link unresolved rather than guessing. A self-referential
link (a page linking its own permalink) is explicitly guarded against
resolving to itself. Two resolution passes happen at every
`finalizeIngestionConfirmation` call, inside its existing transaction:
**forward** (this fetch's own new links, against already-existing items)
and **retroactive** (other, pre-existing unresolved links, against the
item just created) — both call the exact same matching function, so the
policy can never drift between the two directions. Once resolved, a row
is never re-touched, even by a later, unrelated confirmation.

**No full article-body persistence — this remains locked.** The extractor
(`linkExtraction.ts`) reuses the same already-in-memory HTML
`extractMetadata()` already parses (no new fetch), and stores only a
small, per-link-scoped, whitespace-normalized `link_context_snippet`
(≤300 chars, built from DOM sibling text, never serialized HTML) — never
the article body. `source_items.excerpt`'s own "no full-article storage"
policy is unaffected and unchanged.

**Bounds, enforced both in the extractor and at the column level:**
`MAX_EXTRACTED_LINKS_PER_JOB` = 200 (priority-capped content → ambiguous →
chrome, `link_position` ascending as tiebreaker — never a naive
first-N-encountered cut, which would systematically favor early-DOM
nav/chrome over genuine later in-article content); `target_url` /
`normalized_target_url` ≤ 2048 chars (an over-length resolved URL is
**dropped entirely, never truncated** — a truncated URL is a different,
broken URL); `anchor_text` / `link_context_snippet` ≤ 300 chars, `rel_attribute`
≤ 200 chars (all three truncated at a word boundary with a trailing
ellipsis, reusing `metadataExtraction.ts`'s `toExcerpt()` style rather
than a second ad hoc truncation). The raw, pre-resolution `href` is
deliberately **not** persisted at all — the resolved/normalized forms
already carry the useful identity, and an `href` can embed tracking
tokens with no justification for a second stored copy.

**`analyse_provenance`'s prompt only ever receives a narrow slice of this
evidence** (`analyseProvenanceTrigger.ts`'s `getInClusterLinksForCluster` +
`buildKnownOutboundLinksByItem`): only links that are **resolved** AND
whose target is **another item already inside this exact claim's own
cluster** — never an unresolved link, never an out-of-cluster target,
never an arbitrary extracted URL merely because it exists. At most 3
occurrences per directed `(from, to)` pair are forwarded (same
content→ambiguous→chrome, then `link_position` priority as the extractor's
own cap), so a repeated "sources:" footnote block can't balloon the
prompt. The system prompt explicitly tells the model these are mechanical
observations, not proof of citation — a `chrome`-placed link is much
weaker evidence than a `content`-placed one, but even the latter is
weighed, not deferred to automatically, under the same "dependence can be
evidenced, independence must never be inferred" rule already governing
every other part of this operation.

**Fingerprint compatibility (critical, verified against a fixed
pre-feature hash — see `provenanceClusterFingerprint.check.ts`).**
`ClusterItemPayload.knownOutboundLinks` is optional and, when an item has
zero qualifying in-cluster links, is **omitted from the canonical object
entirely** (not serialized as an empty array) — producing byte-identical
JSON, and therefore an identical fingerprint, to what this function
computed before this feature existed. This is what guarantees every
pre-existing successful `analyse_provenance` result across production does
NOT appear stale merely because the payload shape gained a new property.
Only once an item gains real, non-empty link evidence does the canonical
shape — and therefore the hash — change, correctly making a previously
`succeeded` analysis newly eligible for re-analysis under the existing,
unmodified cluster-change-gated rule.

**Nothing about PR8b's own contract changes.** The six AI-proposable
relationship types, direction semantics, the mandatory human-review path,
supersession/actionability rules, the confidence/evidence_note-NULL-on-
approval policy, and the immutable review-snapshot bridge are all
untouched — this PR only enriches `analyse_provenance`'s *input*, never
its output schema or review pipeline.

**Provider-agnostic by design.** Nothing in `source_item_links` or
`linkExtraction.ts` assumes the source item came from a traditional news
article. `from`/`to` reference `source_items` rows regardless of which
discovery provider produced them. This PR does **not** implement any new
discovery provider (GTAForums, Reddit, X, RSS polling, search APIs, or
general crawling/historical backfill) — it is reusable infrastructure a
later Phase 6 provider PR is expected to feed into, each producing this
same bounded evidence shape through its own adapter.

**Corrective fix: visible-text extraction (post-merge).** The initial
implementation's anchor-text/context extraction could be contaminated by
genuinely non-visible DOM content. `linkExtraction.ts` now excludes
`script`, `style`, `noscript`, and `template` subtrees, and any subtree
carrying the HTML `hidden` attribute, from anchor text and
`link_context_snippet` — visible text is collected via iterative
text-node traversal that skips these subtrees outright, rather than a
naive `textContent` read that would include them. This exclusion set is
purely structural — the implementation deliberately does not interpret
CSS `display`, `visibility`, or any other stylesheet-driven signal.
`aria-hidden` is deliberately **not** treated as visual invisibility
— it's an accessibility-tree signal, not a rendering one, so a
sighted-visible/`aria-hidden` link's text is still collected. A link
discarded for being genuinely non-visible still consumes its original
DOM `link_position` — positions are never renumbered around a discard,
preserving the same content → ambiguous → chrome, position-ascending
priority ordering `MAX_EXTRACTED_LINKS_PER_JOB` truncation already
depended on. Accessibility skip links (e.g. "Skip to content") are
classified as `chrome` using narrow structural/semantic signals (specific
to that pattern, not a broad heuristic that could misclassify genuine
in-article links). None of this changes what a `source_item_links` row
*means* — it only improves the quality of the mechanical observation
itself; a hyperlink is still never treated as an automatic provenance
relationship, resolution and the advisory-only feed into
`analyse_provenance` are unaffected.

### Discovery candidate ledger: `discovery_candidates` / `discovery_candidate_observations` (Phase 6 PR 6.1)

A durable ledger sitting **upstream** of `ingestion_jobs` in the discovery
pipeline:

```
provider/feed sighting
        |
        v
discovery_candidate_observations   (one row per operational sighting)
        |
        v
discovery_candidates                (one row per globally-normalized URL)
        |
        v
ingestion_jobs                      (existing Phase 4 pipeline)
```

**Operational discovery facts only — never corroboration, provenance, or
evidence.** Multiple feeds/providers surfacing the same normalized URL
tell the system nothing more than "more than one operational source has
pointed at this URL" — that fact never touches `source_relationships`,
`claims`, or any other epistemic table. That graph remains exclusively
`analyse_provenance`'s and a human's, decided from actual page content and
hyperlink observations (`source_item_links`), never from how many
discovery channels happened to surface the same link.

**One enum, one strict fold order, enforced by the database, never by
enum declaration order.** `discovery_admissibility` is `excluded` <
`held` < `eligible` — a `discovery_admissibility_rank()` SQL function is
the single source of truth for that ordering (mirrored in pure TypeScript
by `ADMISSIBILITY_RANK`/`foldAdmissibility()` in
`src/lib/discovery/candidateEligibility.ts`, for deterministic test parity
only — it is **never** the authority for persisted state). A future
addition to this enum can never silently change fold semantics, because
nothing anywhere compares admissibility values by their position in the
`CREATE TYPE` list.

**A candidate's admissibility is a database-maintained, monotonic fold —
not application discipline.** Every newly inserted `discovery_candidates`
row is forced to `admissibility = 'excluded'` by a `BEFORE INSERT`
trigger, regardless of what any caller supplies — there is deliberately
no application-facing path that creates a candidate at `held`/`eligible`
directly. Inserting a genuine observation is the *only* mechanism that
can raise a candidate's admissibility, via an `AFTER INSERT` trigger on
`discovery_candidate_observations` (`raise_discovery_candidate_admissibility()`)
that takes the rank-wise maximum of the candidate's current admissibility
and the new observation's. A second trigger
(`restrict_discovery_candidate_mutation()`) enforces monotonicity
structurally: admissibility can never decrease, `last_seen_at` can never
move backwards, and `normalized_url`/`first_seen_at`/`created_at` are
immutable identity fields. `DELETE` is rejected outright on both tables —
this ledger never shrinks. Critically, **the guard does not stop at
"never decrease"** — an UPDATE that *raises* admissibility is itself
verified against the candidate's own observations before being allowed:
a candidate may never carry a rank higher than the highest rank actually
represented by one of its observations. An arbitrary direct
`UPDATE ... SET admissibility = 'eligible'` with no qualifying
observation on record is rejected, even though it isn't a decrease —
closing a gap an earlier revision of this trigger left open. The
legitimate path (`INSERT` observation → `AFTER INSERT` raise trigger →
`UPDATE` candidate) always passes this check, because the just-inserted
observation is already visible to the same transaction by the time that
`UPDATE` runs. This could not have been solved by trusting application
code, nor by revoking `UPDATE` from `admin_role` — the replay path
(above) legitimately needs `UPDATE` for `last_seen_at`, so the guard has
to distinguish a *justified* raise from an *unjustified* one at the row
level, not deny the operation category outright.

**Replay is RSS/feed-specific, not a general provider-identity rule.** A
partial unique index on `(discovery_feed_id, discovery_candidate_id)`
(`WHERE discovery_feed_id IS NOT NULL`) is the only replay-idempotency
mechanism in this PR. A repeated sighting of the same candidate by the
same feed resolves via `INSERT ... ON CONFLICT ... DO UPDATE`, advancing
only `last_seen_at` (via `GREATEST`) — never a second observation row,
never a change to admissibility or any other observation column. A
non-feed provider has no such conflict target and always inserts a fresh
row per sighting; that provider's own replay semantics, if any, are a
decision for whichever future PR introduces it, not a rule generalized
from this one. Critically, the candidate's own `last_seen_at` is advanced
by the **candidate upsert itself** (`ON CONFLICT (normalized_url) DO
UPDATE SET last_seen_at = GREATEST(...)`), not by the observation's
`AFTER INSERT` raise trigger — that trigger deliberately fires on
`INSERT` only, never on `UPDATE`, so a replay's forward-only
`last_seen_at` change can never re-evaluate or re-raise admissibility.
Without the candidate's own upsert advancing `last_seen_at` on every
valid sighting (including a replay), a repeatedly-reobserved candidate's
`last_seen_at` would go stale even while its observation kept advancing —
this was caught and corrected during implementation planning before any
code was written.

**The composite candidate/observation link on `ingestion_jobs` is a new
pattern for this codebase — the first multi-column foreign key.**
`discovery_candidate_observations` carries `UNIQUE (id,
discovery_candidate_id)` (its `id` is already a primary key, so no
separate `UNIQUE(id)` is needed); `ingestion_jobs.discovery_candidate_observation_id`
and `discovery_candidate_id` are jointly constrained by
`FOREIGN KEY (discovery_candidate_observation_id, discovery_candidate_id)
REFERENCES discovery_candidate_observations (id, discovery_candidate_id)`.
This proves a job's observation genuinely belongs to its candidate — not
merely that both ids independently exist. Both columns are `NULL` for
every manual/legacy job and populated together, exactly once, only by
candidate promotion. A separate `CHECK` constraint
(`(discovery_candidate_id IS NULL) = (discovery_candidate_observation_id
IS NULL)`) enforces that pairing — verified during implementation to be
load-bearing in its own right, not redundant with the composite FK: a
multi-column foreign key uses `MATCH SIMPLE` semantics by default, which
does **not** enforce the constraint at all when only one of its columns
is `NULL`. Without the separate `CHECK`, a row with
`discovery_candidate_observation_id` set but `discovery_candidate_id`
`NULL` would pass the FK silently. The `CHECK` is what actually closes
that gap.

**Promotion: claim, verify, insert — all in one transaction.**
`claimEligibleCandidatesForPromotion()` (`src/db/mutations/discoveryCandidates.ts`)
selects up to a batch size of eligible candidates using `FOR UPDATE SKIP
LOCKED` (the same batch-worker primitive `discoveryPolling.ts`'s
`claimDueDiscoveryFeeds` already uses), excluding any candidate whose
normalized URL already exists in `ingestion_jobs` (any status, any
provider — a new general-purpose index, `ingestion_jobs_normalized_url_idx`,
supports this) or `source_items`. This exclusion lives in the claim query
itself, not only a later per-row recheck — a URL that was already
manually ingested, or discovered by an old feed run before this ledger
existed, must never be repeatedly reclaimed for promotion. For each
claimed candidate, in the same transaction: the exclusion check is
repeated immediately before `INSERT` (defense-in-depth against a race the
claim query's own snapshot can't fully close), the deterministic
promotion origin is selected (`WHERE admissibility = 'eligible' ORDER BY
first_seen_at ASC, id ASC LIMIT 1` — proven, not merely assumed, to pick
the earliest eligible observation even when a later one is also
eligible), and the `ingestion_jobs` row is created. `submittedUrl` is
that exact origin observation's own `observedUrl` — the raw URL the
provider/feed sighting actually reported — never the candidate's
already-normalized identity; `normalizedUrl` on the job is the
candidate's normalized form; `discoveryProviderId`/`discoveryFeedId` are
copied from that same origin. The insert uses
`INSERT ... ON CONFLICT DO NOTHING` with **no explicit conflict
target** — deliberately, so it covers *any* unique-constraint conflict on
the table in one statement: both
`ingestion_jobs_discovery_candidate_id_unique` (the authoritative
one-candidate-one-job guard) and the pre-existing
`ingestion_jobs_discovery_feed_normalized_url_unique` dedupe index (a
race against the RSS poller claiming the same normalized URL). This is
**not** a caught `23505` — a raised unique-constraint violation aborts
the entire surrounding Postgres transaction until rollback, so catching
the resulting JS exception would not actually recover it; every other
candidate already promoted earlier in the same loop would be silently
lost. `ON CONFLICT DO NOTHING` avoids raising the error at all: a losing
insert simply returns no row, which the code treats as "already handled
by a racing insert" and skips, without ever entering an aborted
transaction state. Verified directly against a real local PostgreSQL
instance under two concurrency scenarios: a manually-held row lock
deterministically demonstrates `SKIP LOCKED` causing a second caller to
skip the locked candidate (and successfully claim it once the lock
releases), and two genuinely concurrent calls to the real function never
promote the same candidate twice.

**No longer dormant as of Phase 6 PR 6.2.** `recordDiscoverySighting()`
and `claimEligibleCandidatesForPromotion()` were dormant when PR 6.1
deployed — no discovery provider called the former, and no route/cron
called the latter, exactly like `source_item_links`'s own rollout one
release earlier. As of PR 6.2, `/api/discovery/poll` is the first real
caller of both, bridging the existing RSS/Atom poller through this
ledger instead of creating `ingestion_jobs` directly (see "RSS bridged
through the discovery candidate ledger" above for the exact flow,
including the new `claimEligibleCandidatesForPromotionByIds()` entry
point PR 6.2 added alongside the two functions described here).
`discoveryPolling.ts`, the RSS production path, `pipeline.ts`, the
ingestion processor, `safeFetch`, cron configuration, `discovery_feeds`,
and the admin UI are otherwise unchanged.

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
