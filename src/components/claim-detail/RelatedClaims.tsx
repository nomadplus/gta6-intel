import Link from "next/link";
import type { RelatedClaim } from "@/db/queries/claimDetail";
import { relatedClaimLabel } from "@/lib/relationshipDisplay";

export function RelatedClaims({ claims }: { claims: RelatedClaim[] }) {
  if (claims.length === 0) {
    return <p className="text-sm text-ink-600">No related claims recorded yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {claims.map((c) => (
        <li key={`${c.id}-${c.relationshipType}`} className="border border-hairline bg-bg-panel p-3">
          <span className="font-mono text-[10px] uppercase tracking-wide text-accent-brass">
            {relatedClaimLabel(c.relationshipType, c.viewedClaimIsA)}
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
