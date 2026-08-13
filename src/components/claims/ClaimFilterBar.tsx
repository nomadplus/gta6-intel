import { investigationStatusDisplay, developmentOutcomeDisplay, informationTypeLabel } from "@/lib/statusDisplay";

export function ClaimFilterBar({
  current,
}: {
  current: {
    q?: string;
    investigationStatus?: string;
    developmentOutcome?: string;
    informationType?: string;
  };
}) {
  return (
    <form
      method="get"
      action="/claims"
      className="mb-8 grid grid-cols-1 gap-3 border border-hairline bg-bg-panel p-4 sm:grid-cols-4"
    >
      <div className="sm:col-span-4">
        <label htmlFor="q" className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">
          Search claim text
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={current.q}
          placeholder="e.g. Vice City, protagonist, weather"
          className="w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus-visible:border-accent-brass"
        />
      </div>

      <Field
        name="investigationStatus"
        label="Investigation status"
        current={current.investigationStatus}
        options={Object.entries(investigationStatusDisplay).map(([value, d]) => ({
          value,
          label: d.label,
        }))}
      />
      <Field
        name="developmentOutcome"
        label="Development outcome"
        current={current.developmentOutcome}
        options={Object.entries(developmentOutcomeDisplay).map(([value, d]) => ({
          value,
          label: d.label,
        }))}
      />
      <Field
        name="informationType"
        label="Information type"
        current={current.informationType}
        options={Object.entries(informationTypeLabel).map(([value, label]) => ({ value, label }))}
      />

      <div className="flex items-end gap-2">
        <button
          type="submit"
          className="w-full border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  current,
  options,
}: {
  name: string;
  label: string;
  current?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={current ?? ""}
        className="w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass"
      >
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
