import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClaimByRef, claimHref } from "@/db/queries/claims";
import {
  getClaimTimeline,
  getClaimSources,
  getClaimProvenanceChain,
  getClaimEvidence,
  getRelatedClaims,
} from "@/db/queries/claimDetail";
import { StatusPair } from "@/components/status/StatusPair";
import { StatusTimeline } from "@/components/claim-detail/StatusTimeline";
import { SourceList } from "@/components/claim-detail/SourceList";
import { ProvenanceChain } from "@/components/claim-detail/ProvenanceChain";
import { EvidenceList } from "@/components/claim-detail/EvidenceList";
import { RelatedClaims } from "@/components/claim-detail/RelatedClaims";
import { InformationTypeTag, SectionHeading } from "@/components/ui/primitives";
import { formatDate } from "@/components/claims/ClaimCard";
import { informationTypeLabel } from "@/lib/statusDisplay";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ref } = await params;
  const claim = await getClaimByRef(ref);
  if (!claim) return {};
  return {
    title: claim.statement,
    description: `Investigation status, sources, evidence and provenance for: ${claim.statement}`,
    alternates: { canonical: claimHref(claim) },
  };
}

export default async function ClaimPage({ params }: Props) {
  const { ref } = await params;
  const claim = await getClaimByRef(ref);
  if (!claim) notFound();

  const [timeline, sources, provenance, evidence, related] = await Promise.all([
    getClaimTimeline(claim.id),
    getClaimSources(claim.id),
    getClaimProvenanceChain(claim.id),
    getClaimEvidence(claim.id),
    getRelatedClaims(claim.id),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
        <InformationTypeTag type={informationTypeLabel[claim.informationType] ?? claim.informationType} />
        {claim.firstReportedAt && (
          <time dateTime={claim.firstReportedAt.toISOString()} className="font-mono">
            First reported {formatDate(claim.firstReportedAt)}
          </time>
        )}
        <span className="font-mono text-ink-600">· Claim #{claim.id}</span>
      </div>

      <h1 className="mt-3 font-display text-3xl italic leading-tight text-ink-100 sm:text-4xl">
        {claim.statement}
      </h1>

      {claim.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {claim.topics.map((t) => (
            <a
              key={t.slug}
              href={`/topics/${t.slug}`}
              className="font-mono text-[10px] uppercase tracking-wide text-ink-600 hover:text-accent-brass"
            >
              #{t.slug}
            </a>
          ))}
        </div>
      )}

      <div className="mt-6">
        <StatusPair
          investigationStatus={claim.currentInvestigationStatus}
          developmentOutcome={claim.currentDevelopmentOutcome}
        />
      </div>

      <section className="mt-12">
        <SectionHeading eyebrow="Audit Trail" title="Status History" />
        <StatusTimeline entries={timeline} />
      </section>

      <section className="mt-12">
        <SectionHeading eyebrow="Provenance" title="Source Chain" />
        <ProvenanceChain links={provenance} />
      </section>

      <section className="mt-12">
        <SectionHeading eyebrow="Reporting" title="Sources" />
        <SourceList sources={sources} />
      </section>

      <section className="mt-12">
        <SectionHeading eyebrow="Substantiation" title="Evidence" />
        <EvidenceList evidence={evidence} />
      </section>

      <section className="mt-12">
        <SectionHeading eyebrow="Cross-reference" title="Related Claims" />
        <RelatedClaims claims={related} />
      </section>
    </div>
  );
}
