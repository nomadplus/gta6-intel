import Link from "next/link";
import { getNotableClaims, getConfirmedClaims, getDisprovenClaims } from "@/db/queries/claims";
import { getSiteStats } from "@/db/queries/stats";
import { ClaimCard } from "@/components/claims/ClaimCard";
import { SectionHeading } from "@/components/ui/primitives";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [notable, confirmed, disproven, stats] = await Promise.all([
    getNotableClaims(4),
    getConfirmedClaims(),
    getDisprovenClaims(),
    getSiteStats(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <section className="max-w-3xl border-b border-hairline pb-10">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">
          A Different Kind of Record
        </div>
        <h1 className="mt-2 font-display text-4xl italic leading-tight text-ink-100 sm:text-5xl">
          Every GTA VI rumour, tracked as a claim — not a headline.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-300">
          This isn&apos;t another news feed. It&apos;s a ledger: each individual claim about GTA VI
          — a setting, a character, a mechanic, a date — is tracked on its own, with its own
          evidence, its own sources, and its own history of what was believed about it over time.
          Fifty articles repeating one leak don&apos;t make it five times as true, and a report can
          be entirely accurate the day it&apos;s published even if the feature it describes is
          later cut. Both are shown here, distinctly, and neither is quietly erased.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/claims"
            className="border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
          >
            Browse all claims
          </Link>
          <Link
            href="/timeline"
            className="border border-hairline px-4 py-2 font-mono text-xs uppercase tracking-wide text-ink-300 hover:border-accent-brass hover:text-accent-brass"
          >
            View the timeline
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px border border-hairline bg-hairline sm:grid-cols-4">
        <Stat label="Claims Tracked" value={stats.totalClaims} />
        <Stat label="Confirmed" value={stats.confirmedClaims} tone="text-signal-confirmed" />
        <Stat label="Disproven" value={stats.disprovenClaims} tone="text-signal-disproven" />
        <Stat label="Source Items" value={stats.totalSourceItems} />
      </section>

      {notable.length > 0 && (
        <section className="mt-14">
          <SectionHeading eyebrow="Recently Tracked" title="Notable Claims" href="/claims" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {notable.map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>
      )}

      {confirmed.length > 0 && (
        <section className="mt-14">
          <SectionHeading eyebrow="Verified" title="Recently Confirmed" href="/confirmed" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {confirmed.slice(0, 2).map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>
      )}

      {disproven.length > 0 && (
        <section className="mt-14">
          <SectionHeading eyebrow="The Rumour Graveyard" title="Disproven" href="/graveyard" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {disproven.slice(0, 2).map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-bg-panel p-5">
      <div className={`font-mono text-3xl font-medium ${tone ?? "text-ink-100"}`}>{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</div>
    </div>
  );
}
