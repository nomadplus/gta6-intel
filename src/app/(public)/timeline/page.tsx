import type { Metadata } from "next";
import Link from "next/link";
import { getGlobalTimeline } from "@/db/queries/claimDetail";
import { investigationStatusDisplay, developmentOutcomeDisplay } from "@/lib/statusDisplay";
import { formatDate } from "@/components/claims/ClaimCard";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Timeline",
  description: "A chronological record of every status change across every tracked GTA VI claim.",
};

function displayLabel(axis: "investigation" | "development_outcome", value: string): string {
  if (axis === "investigation") {
    return investigationStatusDisplay[value as keyof typeof investigationStatusDisplay]?.label ?? value;
  }
  return developmentOutcomeDisplay[value as keyof typeof developmentOutcomeDisplay]?.label ?? value;
}

export default async function TimelinePage() {
  const entries = await getGlobalTimeline(200);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <header className="mb-10">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">
          Chronological Record
        </div>
        <h1 className="font-display text-4xl italic text-ink-100">Timeline</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-400">
          Every recorded status change, across every claim, newest first. The same claim can
          appear more than once — that&apos;s the point: beliefs about GTA VI changed over time,
          and this is the record of exactly how.
        </p>
      </header>

      <ol className="space-y-0 border-l border-hairline">
        {entries.map((entry) => (
          <li key={`${entry.axis}-${entry.transitionId}`} className="relative py-5 pl-6">
            <span
              aria-hidden
              className={`absolute -left-[5px] top-6 h-2.5 w-2.5 rounded-full ${
                entry.axis === "investigation" ? "bg-accent-brass" : "bg-signal-confirmed"
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <time dateTime={entry.changedAt.toISOString()} className="font-mono text-xs text-ink-600">
                {formatDate(entry.changedAt)}
              </time>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-600">
                {entry.axis === "investigation" ? "Investigation Status" : "Development Outcome"}
              </span>
            </div>
            <p className="mt-1">
              <Link
                href={`/claims/${entry.claimId}-${entry.claimSlug}`}
                className="font-display text-lg text-ink-100 hover:text-accent-brass"
              >
                {entry.claimStatement}
              </Link>
            </p>
            <p className="mt-1 text-sm text-ink-300">
              {entry.previousValue ? (
                <>
                  <span className="text-ink-600 line-through">{displayLabel(entry.axis, entry.previousValue)}</span>{" "}
                  → {displayLabel(entry.axis, entry.newValue)}
                </>
              ) : (
                displayLabel(entry.axis, entry.newValue)
              )}
            </p>
            <p className="mt-1 max-w-xl text-xs text-ink-600">{entry.reason}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
