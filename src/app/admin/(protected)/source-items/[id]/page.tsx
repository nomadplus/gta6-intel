import { notFound } from "next/navigation";
import {
  getSourceItemForAdmin,
  listSourcesForAdmin,
  listSourceItemTypeOptions,
  listSourceItemsForAdmin,
  getSourceItemRelationships,
} from "@/db/queries/admin";
import { updateSourceItemAction, createSourceRelationshipAction, deleteSourceRelationshipAction } from "../../sources/actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> };

export default async function AdminSourceItemDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const item = await getSourceItemForAdmin(Number(id));
  if (!item) notFound();

  const [sources, itemTypes, allItems, relationships] = await Promise.all([
    listSourcesForAdmin(),
    listSourceItemTypeOptions(),
    listSourceItemsForAdmin(),
    getSourceItemRelationships(item.id),
  ]);

  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h1 className="font-display text-3xl italic text-ink-100">{item.title ?? item.url}</h1>
        {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
        {saved && <p className="mt-4 border border-signal-confirmed/50 px-3 py-2 text-sm text-signal-confirmed">Saved.</p>}

        <form action={updateSourceItemAction} className="mt-6 space-y-4">
          <input type="hidden" name="sourceItemId" value={item.id} />
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source</label>
            <select name="sourceId" defaultValue={item.sourceId} required className={inputClass}>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Item type</label>
            <select name="itemTypeId" defaultValue={item.itemTypeId} required className={inputClass}>
              {itemTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">URL</label>
            <input name="url" type="url" defaultValue={item.url} required className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Title</label>
            <input name="title" defaultValue={item.title ?? ""} className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Excerpt</label>
            <textarea name="excerpt" defaultValue={item.excerpt ?? ""} rows={3} maxLength={600} className={inputClass} />
          </div>
          <button type="submit" className={submitClass}>Save</button>
        </form>
      </div>

      <section>
        <h2 className="font-mono text-xs uppercase tracking-wide text-accent-brass">Provenance Relationships</h2>
        <p className="mt-1 text-xs text-ink-600">
          Always directional — citation, derivative, repetition, original, and independent corroboration are never
          treated as symmetric.
        </p>

        <ul className="mt-3 divide-y divide-hairline border border-hairline text-sm">
          {relationships.outgoing.map((r) => (
            <li key={`out-${r.id}`} className="flex items-center justify-between p-2">
              <span>
                This item <span className="font-mono text-xs text-accent-brass">{r.relationship_type}</span> {r.other_title ?? r.other_url}
              </span>
              <form action={deleteSourceRelationshipAction}>
                <input type="hidden" name="relationshipId" value={r.id} />
                <input type="hidden" name="sourceItemId" value={item.id} />
                <button className="font-mono text-xs text-ink-600 hover:text-signal-disproven">remove</button>
              </form>
            </li>
          ))}
          {relationships.incoming.map((r) => (
            <li key={`in-${r.id}`} className="flex items-center justify-between p-2">
              <span>
                {r.other_title ?? r.other_url} <span className="font-mono text-xs text-accent-brass">{r.relationship_type}</span> this item
              </span>
              <form action={deleteSourceRelationshipAction}>
                <input type="hidden" name="relationshipId" value={r.id} />
                <input type="hidden" name="sourceItemId" value={item.id} />
                <button className="font-mono text-xs text-ink-600 hover:text-signal-disproven">remove</button>
              </form>
            </li>
          ))}
          {relationships.outgoing.length === 0 && relationships.incoming.length === 0 && (
            <li className="p-2 text-ink-600">No provenance relationships recorded yet.</li>
          )}
        </ul>

        <form action={createSourceRelationshipAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">This item...</label>
            <select name="relationshipType" className={inputClass}>
              <option value="citation">cites</option>
              <option value="repetition">repeats</option>
              <option value="derivative">is derivative of</option>
              <option value="aggregation">aggregates</option>
              <option value="original">is the original source for</option>
              <option value="independent_corroboration">independently corroborates</option>
              <option value="unknown">has an unknown relationship to</option>
            </select>
          </div>
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">...this other item</label>
            <select name="sourceItemIdA" required className={inputClass}>
              {allItems.filter((i) => i.id !== item.id).map((i) => (
                <option key={i.id} value={i.id}>{i.title ?? i.url}</option>
              ))}
            </select>
          </div>
          <input type="hidden" name="sourceItemIdB" value={item.id} />
          <button type="submit" className={submitClass}>Add Relationship</button>
        </form>
      </section>
    </div>
  );
}
