import { notFound } from "next/navigation";
import { getSourceForAdmin, listSourceTypeOptions } from "@/db/queries/admin";
import { updateSourceAction } from "../actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> };

export default async function AdminSourceDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const source = await getSourceForAdmin(Number(id));
  if (!source) notFound();

  const sourceTypes = await listSourceTypeOptions();

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">{source.name}</h1>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      {saved && <p className="mt-4 border border-signal-confirmed/50 px-3 py-2 text-sm text-signal-confirmed">Saved.</p>}

      <form action={updateSourceAction} className="mt-6 space-y-4">
        <input type="hidden" name="sourceId" value={source.id} />
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Name</label>
          <input name="name" defaultValue={source.name} required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source type</label>
          <select name="sourceTypeId" defaultValue={source.sourceTypeId} required className={inputClass}>
            {sourceTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Homepage URL</label>
          <input name="homepageUrl" type="url" defaultValue={source.homepageUrl ?? ""} className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Notes</label>
          <textarea name="notes" defaultValue={source.notes ?? ""} rows={3} className={inputClass} />
        </div>
        <button type="submit" className={submitClass}>Save</button>
      </form>
    </div>
  );
}
