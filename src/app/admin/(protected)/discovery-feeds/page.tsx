import Link from "next/link";
import { listDiscoveryFeedsForAdmin } from "@/db/queries/admin";

function formatDateTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default async function DiscoveryFeedsListPage() {
  const feeds = await listDiscoveryFeedsForAdmin();

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Discovery Feeds</h1>
        <Link
          href="/admin/discovery-feeds/new"
          className="border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
        >
          + New Feed
        </Link>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        RSS/Atom feeds the system is configured to monitor. This page only stores configuration —
        nothing here is fetched, polled, or turned into an ingestion job yet.
      </p>

      {feeds.length === 0 ? (
        <p className="mt-8 text-sm text-ink-600">No discovery feeds configured yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
          {feeds.map((feed) => (
            <li key={feed.id} className="p-3">
              <div className="flex items-center justify-between gap-4">
                <Link
                  href={`/admin/discovery-feeds/${feed.id}`}
                  className="min-w-0 flex-1 truncate text-ink-100 hover:text-accent-brass"
                >
                  {feed.feedUrl}
                </Link>
                <span
                  className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${
                    feed.enabled ? "text-accent-brass" : "text-ink-600"
                  }`}
                >
                  {feed.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                #{feed.id} · {feed.sourceName} · every {feed.pollingIntervalMinutes}m · added{" "}
                {formatDateTime(feed.createdAt)}
              </div>
              {feed.lastPolledAt && (
                <p className="mt-1 font-mono text-xs text-ink-600">
                  Last polled {formatDateTime(feed.lastPolledAt)}
                  {feed.lastPollStatus ? ` — ${feed.lastPollStatus}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
