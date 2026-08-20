import { notFound } from "next/navigation";
import { getDiscoveryFeedForAdmin, listSourcesForAdmin } from "@/db/queries/admin";
import { updateDiscoveryFeedAction } from "../actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

function formatDateTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> };

export default async function DiscoveryFeedDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const feed = await getDiscoveryFeedForAdmin(Number(id));
  if (!feed) notFound();

  const sources = await listSourcesForAdmin();

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl italic text-ink-100">Feed #{feed.id}</h1>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
        {feed.sourceName} · added {formatDateTime(feed.createdAt)}
      </p>
      {feed.lastPolledAt && (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
          Last polled {formatDateTime(feed.lastPolledAt)}
          {feed.lastPollStatus ? ` — ${feed.lastPollStatus}` : ""}
        </p>
      )}
      {!feed.lastPolledAt && (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
          Never polled — polling is not implemented yet.
        </p>
      )}

      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      {saved && <p className="mt-4 border border-signal-confirmed/50 px-3 py-2 text-sm text-signal-confirmed">Saved.</p>}

      <form action={updateDiscoveryFeedAction} className="mt-6 space-y-4">
        <input type="hidden" name="feedId" value={feed.id} />
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Source</label>
          <select name="sourceId" defaultValue={feed.sourceId} required className={inputClass}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Feed URL</label>
          <input name="feedUrl" type="url" defaultValue={feed.feedUrl} required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Polling interval (minutes)</label>
          <input
            name="pollingIntervalMinutes"
            type="number"
            min={1}
            step={1}
            defaultValue={feed.pollingIntervalMinutes}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Status</label>
          <select name="enabled" defaultValue={feed.enabled ? "true" : "false"} className={inputClass}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        <button type="submit" className={submitClass}>Save</button>
      </form>
    </div>
  );
}
