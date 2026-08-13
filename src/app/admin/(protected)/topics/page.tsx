import { listTopicsForAdmin } from "@/db/queries/admin";
import { createTopicAction, renameTopicAction } from "../evidence/actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

export default async function AdminTopicsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { error, saved } = await searchParams;
  const topics = await listTopicsForAdmin();

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl italic text-ink-100">Topics</h1>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      {saved && <p className="mt-4 border border-signal-confirmed/50 px-3 py-2 text-sm text-signal-confirmed">Saved.</p>}

      <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
        {topics.map((t) => (
          <li key={t.id} className="p-3">
            <details>
              <summary className="flex cursor-pointer items-center justify-between">
                <span className="text-ink-100">{t.name}</span>
                <span className="font-mono text-xs text-ink-600">{t.claimCount} claim(s)</span>
              </summary>
              <form action={renameTopicAction} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="topicId" value={t.id} />
                <div className="min-w-[160px] flex-1">
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Name</label>
                  <input name="name" defaultValue={t.name} required className={inputClass} />
                </div>
                <div className="min-w-[160px] flex-1">
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Slug</label>
                  <input name="slug" defaultValue={t.slug} required className={inputClass} />
                </div>
                <button type="submit" className={submitClass}>Rename</button>
              </form>
            </details>
          </li>
        ))}
      </ul>

      <section className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-wide text-accent-brass">New Topic</h2>
        <form action={createTopicAction} className="mt-3 space-y-3">
          <input type="hidden" name="projectId" value="1" />
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Name</label>
            <input name="name" required className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Slug</label>
            <input name="slug" required className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Description (optional)</label>
            <textarea name="description" rows={2} className={inputClass} />
          </div>
          <button type="submit" className={submitClass}>Create Topic</button>
        </form>
      </section>
    </div>
  );
}
