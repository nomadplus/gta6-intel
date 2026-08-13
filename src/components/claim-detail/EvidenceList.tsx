import type { ClaimEvidenceItem } from "@/db/queries/claimDetail";

const stanceLabel: Record<string, string> = {
  supports: "Supports",
  contradicts: "Contradicts",
  mentions: "Mentions",
};

export function EvidenceList({ evidence }: { evidence: ClaimEvidenceItem[] }) {
  if (evidence.length === 0) {
    return <p className="text-sm text-ink-600">No evidence linked to this claim yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {evidence.map((e) => (
        <li key={e.evidenceId} className="border border-hairline bg-bg-panel p-4">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-600">
            <span className="border border-hairline px-1.5 py-0.5">{e.evidenceType.replaceAll("_", " ")}</span>
            <span
              className={
                e.stance === "contradicts"
                  ? "text-signal-disproven"
                  : e.stance === "supports"
                    ? "text-signal-confirmed"
                    : "text-ink-400"
              }
            >
              {stanceLabel[e.stance] ?? e.stance}
            </span>
            <span>{e.addedBy === "ai" ? "AI-extracted" : "Human-recorded"}</span>
          </div>
          <p className="mt-2 text-sm text-ink-100">{e.description}</p>
          {e.sourceItemUrl && (
            <a
              href={e.sourceItemUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-1 inline-block text-xs text-ink-600 hover:text-accent-brass"
            >
              {e.sourceItemTitle ?? e.sourceItemUrl}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
