import { createDiscoveryFeedAction } from "../actions";
import { listSourcesForAdmin } from "@/db/queries/admin";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

export default async function NewDiscoveryFeedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const sources = await listSourcesForAdmin();

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">New Discovery Feed</h1>
      <p className="mt-2 text-sm text-ink-400">
        Registers an RSS/Atom feed to monitor. This does not fetch or validate the feed's contents —
        only the URL is checked and normalized.
      </p>
      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      <form action={createDiscoveryFeedAction} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source</label>
          <select name="sourceId" required className={inputClass}>
            <option value="">Select a source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-600">
            A feed must belong to an existing source. Create one first under Sources if it doesn't
            exist yet.
          </p>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Feed URL</label>
          <input name="feedUrl" type="url" required placeholder="https://example.com/feed.xml" className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Polling interval (minutes)</label>
          <input
            name="pollingIntervalMinutes"
            type="number"
            min={1}
            step={1}
            defaultValue={60}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Status</label>
          <select name="enabled" defaultValue="true" className={inputClass}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        <button type="submit" className={submitClass}>Create Feed</button>
      </form>
    </div>
  );
}
