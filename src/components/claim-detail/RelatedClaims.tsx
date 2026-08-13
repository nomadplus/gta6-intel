import Link from "next/link";
import type { RelatedClaim } from "@/db/queries/claimDetail";

const relationshipLabel: Record<string, string> = {
  equivalent: "Equivalent to",
  subsumes: "Subsumes",
  refines: "Refined by",
  contradicts: "Contradicts",
  related: "Related to",
};

export function RelatedClaims({ claims }: { claims: RelatedClaim[] }) {
  if (claims.length === 0) {
    return <p className="text-sm text-ink-600">No related claims recorded yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {claims.map((c) => (
        <li key={c.id} className="border border-hairline bg-bg-panel p-3">
          <span className="font-mono text-[10px] uppercase tracking-wide text-accent-brass">
            {relationshipLabel[c.relationshipType] ?? c.relationshipType}
          </span>
          <p className="mt-1">
            <Link href={`/claims/${c.id}-${c.slug}`} className="text-ink-100 hover:text-accent-brass">
              {c.statement}
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}
