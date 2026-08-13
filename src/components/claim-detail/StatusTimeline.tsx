import type { TimelineEntry } from "@/db/queries/claimDetail";
import { investigationStatusDisplay, developmentOutcomeDisplay } from "@/lib/statusDisplay";
import { formatDate } from "@/components/claims/ClaimCard";

const axisLabel: Record<TimelineEntry["axis"], string> = {
  investigation: "Investigation Status",
  development_outcome: "Development Outcome",
};

function displayLabel(axis: TimelineEntry["axis"], value: string): string {
  if (axis === "investigation") {
    return investigationStatusDisplay[value as keyof typeof investigationStatusDisplay]?.label ?? value;
  }
  return developmentOutcomeDisplay[value as keyof typeof developmentOutcomeDisplay]?.label ?? value;
}

export function StatusTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-ink-600">No recorded status history yet.</p>;
  }

  return (
    <ol className="space-y-0 border-l border-hairline">
      {entries.map((entry, i) => (
        <li key={`${entry.axis}-${entry.transitionId}`} className="relative py-4 pl-6">
          <span
            aria-hidden
            className={`absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full ${
              entry.axis === "investigation" ? "bg-accent-brass" : "bg-signal-confirmed"
            }`}
          />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-600">
              {axisLabel[entry.axis]}
            </span>
            <time dateTime={entry.changedAt.toISOString()} className="font-mono text-xs text-ink-600">
              {formatDate(entry.changedAt)}
            </time>
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-600">
              {entry.initiatedBy === "ai" ? "AI-proposed, admin-approved" : "Human-recorded"}
            </span>
          </div>
          <p className="mt-1 font-display text-lg text-ink-100">
            {entry.previousValue ? (
              <>
                <span className="text-ink-400 line-through decoration-ink-600">
                  {displayLabel(entry.axis, entry.previousValue)}
                </span>{" "}
                → <span>{displayLabel(entry.axis, entry.newValue)}</span>
              </>
            ) : (
              <span>{displayLabel(entry.axis, entry.newValue)}</span>
            )}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-ink-300">{entry.reason}</p>
          {entry.confidence && (
            <p className="mt-1 font-mono text-xs text-ink-600">
              confidence: {Number(entry.confidence).toFixed(2)}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
