import type { Metadata } from "next";
import Link from "next/link";
import { getConfirmedWithTiming } from "@/db/queries/stats";
import { EmptyState } from "@/components/ui/primitives";
import { formatDate } from "@/components/claims/ClaimCard";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirmed",
  description: "GTA VI claims that have been officially confirmed, and how long it took.",
};

export default async function ConfirmedPage() {
  const claims = await getConfirmedWithTiming();

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <header className="mb-8 max-w-2xl">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal-confirmed">
          Verified
        </div>
        <h1 className="font-display text-4xl italic text-ink-100">Confirmed Years Later</h1>
        <p className="mt-2 text-sm text-ink-400">
          Claims that reached Confirmed status, and how much time passed between the first report
          and confirmation. Duration is only shown where both dates are actually on record — never
          estimated.
        </p>
      </header>

      {claims.length === 0 ? (
        <EmptyState title="Nothing confirmed yet" body="No claims have reached Confirmed status yet." />
      ) : (
        <ul className="divide-y divide-hairline border border-hairline">
          {claims.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <Link href={`/claims/${c.id}-${c.slug}`} className="font-display text-lg text-ink-100 hover:text-accent-brass">
                  {c.statement}
                </Link>
                <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-xs text-ink-600">
                  {c.firstReportedAt && <span>Reported {formatDate(c.firstReportedAt)}</span>}
                  {c.confirmedAt && <span>Confirmed {formatDate(c.confirmedAt)}</span>}
                </div>
              </div>
              {c.daysToConfirm !== null && (
                <div className="shrink-0 border border-signal-confirmed/50 px-3 py-2 text-right">
                  <div className="font-mono text-xl text-signal-confirmed">{c.daysToConfirm}</div>
                  <div className="font-mono text-[10px] uppercase tracking-wide text-ink-600">days</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
