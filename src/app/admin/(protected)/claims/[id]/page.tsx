import { notFound } from "next/navigation";
import { getClaimForAdmin, listTopicsForAdmin, listSourceItemsForAdmin, listEvidenceForAdmin, listClaimsForAdmin } from "@/db/queries/admin";
import { getClaimTimeline, getClaimSources, getClaimEvidence, getRelatedClaims } from "@/db/queries/claimDetail";
import { StatusPair } from "@/components/status/StatusPair";
import { investigationStatusDisplay, developmentOutcomeDisplay, informationTypeLabel } from "@/lib/statusDisplay";
import {
  updateClaimMetadataAction,
  transitionInvestigationStatusAction,
  transitionDevelopmentOutcomeAction,
  linkClaimSourceAction,
  unlinkClaimSourceAction,
  linkEvidenceToClaimAction,
  unlinkEvidenceFromClaimAction,
  createClaimRelationshipAction,
  deleteClaimRelationshipAction,
} from "../actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass =
  "border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function AdminClaimDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const claimId = Number(id);
  const { error, saved } = await searchParams;

  const claim = await getClaimForAdmin(claimId);
  if (!claim) notFound();

  const [timeline, claimSources, claimEvidenceRows, related, topics, sourceItems, allEvidence, allClaims] =
    await Promise.all([
      getClaimTimeline(claimId),
      getClaimSources(claimId),
      getClaimEvidence(claimId),
      getRelatedClaims(claimId),
      listTopicsForAdmin(),
      listSourceItemsForAdmin(),
      listEvidenceForAdmin(),
      listClaimsForAdmin(),
    ]);

  return (
    <div className="max-w-4xl space-y-12">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Claim #{claim.id}</div>
        <h1 className="font-display text-3xl italic text-ink-100">{claim.statement}</h1>
        <div className="mt-3">
          <StatusPair
            investigationStatus={claim.currentInvestigationStatus}
            developmentOutcome={claim.currentDevelopmentOutcome}
          />
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {saved && <Banner tone="ok">Saved.</Banner>}

      <Section title="Metadata">
        <form action={updateClaimMetadataAction} className="space-y-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Statement">
            <textarea name="statement" defaultValue={claim.statement} required rows={3} className={inputClass} />
          </Field>
          <Field label="Slug">
            <input name="slug" defaultValue={claim.slug} required className={inputClass} />
          </Field>
          <Field label="Information type">
            <select name="informationType" defaultValue={claim.informationType} className={inputClass}>
              {Object.entries(informationTypeLabel).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="First reported date">
            <input
              type="date"
              name="firstReportedAt"
              defaultValue={claim.firstReportedAt ? new Date(claim.firstReportedAt).toISOString().slice(0, 10) : ""}
              className={inputClass}
            />
          </Field>
          <Field label="Topics">
            <select name="topicIds" multiple defaultValue={[]} className={`${inputClass} h-28`}>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Save Metadata
          </button>
        </form>
      </Section>

      <Section title="Investigation Status" note="Never edited directly — this always creates a new append-only transition.">
        <TimelineList entries={timeline.filter((t) => t.axis === "investigation")} />
        <form action={transitionInvestigationStatusAction} className="mt-4 space-y-3 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="New status">
            <select name="newStatus" required className={inputClass}>
              {Object.entries(investigationStatusDisplay).map(([v, d]) => (
                <option key={v} value={v}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason">
            <textarea name="reason" required rows={2} className={inputClass} />
          </Field>
          <Field label="Confidence (0–1, optional)">
            <input name="confidence" type="number" step="0.01" min="0" max="1" className={inputClass} />
          </Field>
          <button type="submit" className={submitClass}>
            Record Investigation Status Change
          </button>
        </form>
      </Section>

      <Section title="Development Outcome" note="Never edited directly — this always creates a new append-only transition.">
        <TimelineList entries={timeline.filter((t) => t.axis === "development_outcome")} />
        <form action={transitionDevelopmentOutcomeAction} className="mt-4 space-y-3 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="New outcome">
            <select name="newOutcome" required className={inputClass}>
              {Object.entries(developmentOutcomeDisplay).map(([v, d]) => (
                <option key={v} value={v}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason">
            <textarea name="reason" required rows={2} className={inputClass} />
          </Field>
          <Field label="Confidence (0–1, optional)">
            <input name="confidence" type="number" step="0.01" min="0" max="1" className={inputClass} />
          </Field>
          <button type="submit" className={submitClass}>
            Record Development Outcome Change
          </button>
        </form>
      </Section>

      <Section title="Sources">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {claimSources.map((s) => (
            <li key={s.claimSourceId} className="flex items-center justify-between p-2">
              <span>
                {s.title ?? s.url} <span className="font-mono text-xs text-ink-600">({s.stance})</span>
              </span>
              <form action={unlinkClaimSourceAction}>
                <input type="hidden" name="linkId" value={s.claimSourceId} />
                <input type="hidden" name="claimId" value={claim.id} />
                <button className="font-mono text-xs text-ink-600 hover:text-signal-disproven">unlink</button>
              </form>
            </li>
          ))}
          {claimSources.length === 0 && <li className="p-2 text-ink-600">No sources linked yet.</li>}
        </ul>
        <form action={linkClaimSourceAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Source item">
            <select name="sourceItemId" required className={inputClass}>
              {sourceItems.map((si) => (
                <option key={si.id} value={si.id}>
                  {si.title ?? si.url}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stance">
            <select name="stance" className={inputClass}>
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="mentions">Mentions</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Source
          </button>
        </form>
      </Section>

      <Section title="Evidence" note="Many-to-many — the same evidence can support or contradict multiple claims.">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {claimEvidenceRows.map((e) => (
            <li key={e.evidenceId} className="flex items-center justify-between p-2">
              <span>
                {e.description} <span className="font-mono text-xs text-ink-600">({e.stance})</span>
              </span>
            </li>
          ))}
          {claimEvidenceRows.length === 0 && <li className="p-2 text-ink-600">No evidence linked yet.</li>}
        </ul>
        <form action={linkEvidenceToClaimAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimId" value={claim.id} />
          <Field label="Evidence">
            <select name="evidenceId" required className={inputClass}>
              {allEvidence.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  #{ev.id} — {ev.description.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stance">
            <select name="stance" className={inputClass}>
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="mentions">Mentions</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Evidence
          </button>
        </form>
      </Section>

      <Section title="Related Claims" note="Equivalent, related, and contradicts are canonicalized automatically — direction doesn't matter for those. Subsumes and refines stay directional.">
        <ul className="divide-y divide-hairline border border-hairline text-sm">
          {related.map((r) => (
            <li key={`${r.id}-${r.relationshipType}`} className="flex items-center justify-between p-2">
              <span>
                <span className="font-mono text-xs uppercase text-accent-brass">{r.relationshipType}</span> {r.statement}
              </span>
            </li>
          ))}
          {related.length === 0 && <li className="p-2 text-ink-600">No related claims yet.</li>}
        </ul>
        <form action={createClaimRelationshipAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="claimIdA" value={claim.id} />
          <Field label="Related claim">
            <select name="claimIdB" required className={inputClass}>
              {allClaims
                .filter((c) => c.id !== claim.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} — {c.statement.slice(0, 60)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Relationship type">
            <select name="relationshipType" className={inputClass}>
              <option value="equivalent">Equivalent</option>
              <option value="related">Related</option>
              <option value="contradicts">Contradicts</option>
              <option value="subsumes">Subsumes (this claim subsumes the other)</option>
              <option value="refines">Refines (this claim refines the other)</option>
            </select>
          </Field>
          <button type="submit" className={submitClass}>
            Link Claim
          </button>
        </form>
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-mono text-xs uppercase tracking-wide text-accent-brass">{title}</h2>
      {note && <p className="mt-1 text-xs text-ink-600">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[180px] flex-1">
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</label>
      {children}
    </div>
  );
}

function Banner({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <p
      className={`border px-3 py-2 text-sm ${
        tone === "error" ? "border-signal-disproven/50 text-signal-disproven" : "border-signal-confirmed/50 text-signal-confirmed"
      }`}
    >
      {children}
    </p>
  );
}

function TimelineList({ entries }: { entries: Awaited<ReturnType<typeof getClaimTimeline>> }) {
  if (entries.length === 0) return <p className="text-sm text-ink-600">No transitions recorded yet.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {entries.map((e) => (
        <li key={e.transitionId} className="border-b border-hairline pb-2">
          <span className="font-mono text-xs text-ink-600">{new Date(e.changedAt).toLocaleDateString()}</span>{" "}
          {e.previousValue ? `${e.previousValue} → ${e.newValue}` : e.newValue}
          <p className="text-xs text-ink-400">{e.reason}</p>
        </li>
      ))}
    </ul>
  );
}
