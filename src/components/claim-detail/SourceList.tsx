import type { ClaimSourceItem } from "@/db/queries/claimDetail";
import { formatDate } from "@/components/claims/ClaimCard";

const stanceLabel: Record<string, string> = {
  supports: "Supports",
  contradicts: "Contradicts",
  mentions: "Mentions",
};

export function SourceList({ sources }: { sources: ClaimSourceItem[] }) {
  if (sources.length === 0) {
    return <p className="text-sm text-ink-600">No sources recorded yet.</p>;
  }

  return (
    <ul className="divide-y divide-hairline border border-hairline">
      {sources.map((s) => (
        <li key={s.claimSourceId} className="p-4">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-600">
            <span className="border border-hairline px-1.5 py-0.5">{s.itemTypeLabel}</span>
            <span
              className={
                s.stance === "contradicts"
                  ? "text-signal-disproven"
                  : s.stance === "supports"
                    ? "text-signal-confirmed"
                    : "text-ink-400"
              }
            >
              {stanceLabel[s.stance] ?? s.stance}
            </span>
            {s.publishedAt && <span>{formatDate(s.publishedAt)}</span>}
          </div>
          <p className="mt-2 font-display text-base text-ink-100">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-accent-brass">
                {s.title ?? s.url}
              </a>
            ) : (
              s.title
            )}
          </p>
          <p className="mt-1 text-sm text-ink-400">{s.sourceName}</p>
          {s.supportingExcerpt && (
            <p className="mt-2 border-l-2 border-hairline pl-3 text-sm italic text-ink-400">
              “{s.supportingExcerpt}”
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
