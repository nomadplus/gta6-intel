import {
  investigationStatusDisplay,
  developmentOutcomeDisplay,
  toneClass,
} from "@/lib/statusDisplay";
import type { InvestigationStatus, DevelopmentOutcome } from "@/db/queries/claims";

function Stamp({
  eyebrow,
  label,
  className,
}: {
  eyebrow: string;
  label: string;
  className: string;
}) {
  return (
    <div className={`border px-3 py-2 ${className}`}>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-600">
        {eyebrow}
      </div>
      <div className="font-mono text-sm font-medium">{label}</div>
    </div>
  );
}

export function StatusPair({
  investigationStatus,
  developmentOutcome,
}: {
  investigationStatus: InvestigationStatus;
  developmentOutcome: DevelopmentOutcome;
}) {
  const inv = investigationStatusDisplay[investigationStatus];
  const dev = developmentOutcomeDisplay[developmentOutcome];

  return (
    <div className="flex flex-wrap gap-2">
      <Stamp eyebrow="Investigation" label={inv.label} className={toneClass[inv.tone]} />
      <Stamp eyebrow="Outcome" label={dev.label} className={toneClass[dev.tone]} />
    </div>
  );
}

export function InvestigationStatusBadge({ status }: { status: InvestigationStatus }) {
  const d = investigationStatusDisplay[status];
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 font-mono text-xs ${toneClass[d.tone]}`}
    >
      {d.label}
    </span>
  );
}

export function DevelopmentOutcomeBadge({ outcome }: { outcome: DevelopmentOutcome }) {
  const d = developmentOutcomeDisplay[outcome];
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 font-mono text-xs ${toneClass[d.tone]}`}
    >
      {d.label}
    </span>
  );
}
