import { createClaimAction } from "../actions";
import { listTopicsForAdmin } from "@/db/queries/admin";
import { investigationStatusDisplay, developmentOutcomeDisplay, informationTypeLabel } from "@/lib/statusDisplay";

export default async function NewClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const topics = await listTopicsForAdmin();

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-3xl italic text-ink-100">New Claim</h1>
      <p className="mt-2 max-w-xl text-sm text-ink-400">
        Create separate claims if parts of a statement could have different truth values or
        different evidence — e.g. "two protagonists," "female protagonist," and "set in Vice
        City" are three claims, not one.
      </p>

      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}

      <form action={createClaimAction} className="mt-6 space-y-4">
        <input type="hidden" name="projectId" value="1" />

        <Field label="Canonical statement">
          <textarea name="statement" required rows={3} className={inputClass} />
        </Field>
        <Field label="Slug">
          <input name="slug" required placeholder="e.g. underwater-exploration" className={inputClass} />
        </Field>
        <Field label="Information type">
          <select name="informationType" required className={inputClass}>
            {Object.entries(informationTypeLabel).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="First reported date (optional)">
          <input type="date" name="firstReportedAt" className={inputClass} />
        </Field>
        <Field label="Topics">
          <select name="topicIds" multiple className={`${inputClass} h-32`}>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Initial Investigation Status">
          <select name="initialInvestigationStatus" defaultValue="unverified" className={inputClass}>
            {Object.entries(investigationStatusDisplay).map(([v, d]) => (
              <option key={v} value={v}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Initial Development Outcome">
          <select name="initialDevelopmentOutcome" defaultValue="unknown" className={inputClass}>
            {Object.entries(developmentOutcomeDisplay).map(([v, d]) => (
              <option key={v} value={v}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason for initial status">
          <textarea name="reason" required rows={2} className={inputClass} />
        </Field>

        <button type="submit" className={submitClass}>
          Create Claim
        </button>
      </form>
    </div>
  );
}

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass =
  "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</label>
      {children}
    </div>
  );
}
