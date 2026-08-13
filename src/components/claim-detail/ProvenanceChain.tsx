import type { ProvenanceLink } from "@/db/queries/claimDetail";

const relationshipVerb: Record<string, string> = {
  original: "is the original source for",
  independent_corroboration: "independently corroborates",
  citation: "cites",
  repetition: "repeats",
  aggregation: "aggregates",
  derivative: "derives from",
  unknown: "has an unknown relationship to",
};

export function ProvenanceChain({ links }: { links: ProvenanceLink[] }) {
  if (links.length === 0) {
    return (
      <p className="text-sm text-ink-600">
        No recorded relationships between this claim&apos;s sources. Treat each source as
        independent unless later evidence says otherwise.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-ink-400">
        Not every source below is an independent confirmation — some are citing or repeating
        each other. The chain shows what&apos;s actually known.
      </p>
      <ul className="space-y-2">
        {links.map((link, i) => (
          <li
            key={i}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-hairline bg-bg-panel px-4 py-3 text-sm"
          >
            <span className="font-medium text-ink-100">{link.fromTitle ?? link.fromUrl}</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-accent-brass">
              {relationshipVerb[link.relationshipType] ?? link.relationshipType}
            </span>
            <span className="font-medium text-ink-100">{link.toTitle ?? link.toUrl}</span>
            {link.confidence && (
              <span className="ml-auto font-mono text-xs text-ink-600">
                confidence {Number(link.confidence).toFixed(2)}
              </span>
            )}
            {link.evidenceNote && (
              <p className="mt-1 w-full text-xs text-ink-600">{link.evidenceNote}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
