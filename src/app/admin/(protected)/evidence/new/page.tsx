import { createEvidenceAction } from "../actions";
import { listSourceItemsForAdmin } from "@/db/queries/admin";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

export default async function NewEvidencePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const sourceItems = await listSourceItemsForAdmin();

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">New Evidence</h1>
      <p className="mt-2 text-sm text-ink-400">
        No claim link is required here. Evidence can be created first and matched to one or more
        claims later — that's a deliberate part of the data model, not a missing step.
      </p>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      <form action={createEvidenceAction} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Description</label>
          <textarea name="description" required rows={3} className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Evidence type</label>
          <input name="evidenceType" required placeholder="e.g. frame_observation, leaked_footage_description" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source item (optional)</label>
          <select name="sourceItemId" className={inputClass}>
            <option value="">— none —</option>
            {sourceItems.map((si) => (
              <option key={si.id} value={si.id}>{si.title ?? si.url}</option>
            ))}
          </select>
        </div>
        <button type="submit" className={submitClass}>Create Evidence</button>
      </form>
    </div>
  );
}
