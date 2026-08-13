import { createSourceAction } from "../actions";
import { listSourceTypeOptions } from "@/db/queries/admin";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

export default async function NewSourcePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const sourceTypes = await listSourceTypeOptions();

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">New Source</h1>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      <form action={createSourceAction} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Name</label>
          <input name="name" required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source type</label>
          <select name="sourceTypeId" required className={inputClass}>
            {sourceTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Homepage URL</label>
          <input name="homepageUrl" type="url" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Notes</label>
          <textarea name="notes" rows={3} className={inputClass} />
        </div>
        <button type="submit" className={submitClass}>Create Source</button>
      </form>
    </div>
  );
}
