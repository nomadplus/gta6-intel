import type { Metadata } from "next";
import { getClaims, searchClaims } from "@/db/queries/claims";
import { ClaimCard } from "@/components/claims/ClaimCard";
import { ClaimFilterBar } from "@/components/claims/ClaimFilterBar";
import { EmptyState } from "@/components/ui/primitives";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "All Claims",
  description: "Browse every tracked GTA VI claim, filterable by status, outcome, type and topic.",
};

type Props = {
  searchParams: Promise<{
    q?: string;
    investigationStatus?: string;
    developmentOutcome?: string;
    informationType?: string;
  }>;
};

export default async function ClaimsIndexPage({ searchParams }: Props) {
  const sp = await searchParams;
  const claims = sp.q ? await searchClaims(sp.q) : await getClaims(sp);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <header className="mb-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">
          The Full Record
        </div>
        <h1 className="font-display text-4xl italic text-ink-100">All Claims</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          Every claim tracked so far, independent of how it turned out. Filter by how well-evidenced
          it is, what happened in development, and what kind of information it originally was.
        </p>
      </header>

      <ClaimFilterBar current={sp} />

      {claims.length === 0 ? (
        <EmptyState
          title="No claims match these filters"
          body="Try clearing a filter or searching a different term."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {claims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} />
          ))}
        </div>
      )}
    </div>
  );
}
