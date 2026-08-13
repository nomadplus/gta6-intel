import type { Metadata } from "next";
import { getDisprovenClaims } from "@/db/queries/claims";
import { ClaimCard } from "@/components/claims/ClaimCard";
import { EmptyState } from "@/components/ui/primitives";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rumour Graveyard",
  description: "GTA VI claims that were reported but ultimately disproven.",
};

export default async function GraveyardPage() {
  const claims = await getDisprovenClaims();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <header className="mb-8 max-w-2xl">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal-disproven">
          The Record Is Honest In Both Directions
        </div>
        <h1 className="font-display text-4xl italic text-ink-100">Rumour Graveyard</h1>
        <p className="mt-2 text-sm text-ink-400">
          Claims that were reported, investigated, and ultimately contradicted by later evidence
          or official material. A site that only remembers what turned out true isn&apos;t a
          record — it&apos;s a highlight reel. These stay visible.
        </p>
      </header>

      {claims.length === 0 ? (
        <EmptyState title="Nothing here yet" body="No claims have been disproven so far." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {claims.map((c) => (
            <ClaimCard key={c.id} claim={c} />
          ))}
        </div>
      )}
    </div>
  );
}
