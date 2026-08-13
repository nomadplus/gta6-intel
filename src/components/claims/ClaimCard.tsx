import Link from "next/link";
import type { ClaimSummary } from "@/db/queries/claims";
import { claimHref } from "@/db/queries/claims";
import { StatusPair } from "@/components/status/StatusPair";
import { InformationTypeTag } from "@/components/ui/primitives";
import { informationTypeLabel } from "@/lib/statusDisplay";

export function ClaimCard({ claim }: { claim: ClaimSummary }) {
  return (
    <article className="border border-hairline bg-bg-panel p-5 transition-colors hover:border-accent-brass/60">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
        <InformationTypeTag type={informationTypeLabel[claim.informationType] ?? claim.informationType} />
        {claim.firstReportedAt && (
          <time dateTime={claim.firstReportedAt.toISOString()} className="font-mono">
            First reported {formatDate(claim.firstReportedAt)}
          </time>
        )}
      </div>

      <h3 className="mt-3 font-display text-xl leading-snug text-ink-100">
        <Link href={claimHref(claim)} className="hover:text-accent-brass">
          {claim.statement}
        </Link>
      </h3>

      <div className="mt-4">
        <StatusPair
          investigationStatus={claim.currentInvestigationStatus}
          developmentOutcome={claim.currentDevelopmentOutcome}
        />
      </div>

      {claim.topics.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {claim.topics.map((t) => (
            <Link
              key={t.slug}
              href={`/topics/${t.slug}`}
              className="font-mono text-[10px] uppercase tracking-wide text-ink-600 hover:text-accent-brass"
            >
              #{t.slug}
            </Link>
          ))}
        </div>
      )}
    </article>
  );
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric" }).format(
    date
  );
}
