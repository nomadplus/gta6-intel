import { createSourceItemAction } from "../../sources/actions";
import { listSourcesForAdmin, listSourceItemTypeOptions } from "@/db/queries/admin";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

export default async function NewSourceItemPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const [sources, itemTypes] = await Promise.all([listSourcesForAdmin(), listSourceItemTypeOptions()]);

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">New Source Item</h1>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      <form action={createSourceItemAction} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source</label>
          <select name="sourceId" required className={inputClass}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Item type</label>
          <select name="itemTypeId" required className={inputClass}>
            {itemTypes.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">URL</label>
          <input name="url" type="url" required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Canonical URL (optional)</label>
          <input name="canonicalUrl" type="url" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Title</label>
          <input name="title" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Author</label>
          <input name="author" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Published date</label>
          <input name="publishedAt" type="date" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Excerpt (max 600 chars)</label>
          <p className="mb-1 text-xs text-ink-600">
            A short supporting quote only — never the full article. Summarize the rest in your own words elsewhere.
          </p>
          <textarea name="excerpt" rows={3} maxLength={600} className={inputClass} />
        </div>
        <button type="submit" className={submitClass}>Create Source Item</button>
      </form>
    </div>
  );
}
