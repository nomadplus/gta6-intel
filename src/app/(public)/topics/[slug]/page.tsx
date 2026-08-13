import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTopicBySlug, getTopicClaims } from "@/db/queries/topics";
import { ClaimCard } from "@/components/claims/ClaimCard";
import { EmptyState } from "@/components/ui/primitives";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const topic = await getTopicBySlug(slug);
  if (!topic) return {};
  return {
    title: topic.name,
    description: topic.description ?? `GTA VI claims related to ${topic.name}.`,
    alternates: { canonical: `/topics/${topic.slug}` },
  };
}

export default async function TopicPage({ params }: Props) {
  const { slug } = await params;
  const topic = await getTopicBySlug(slug);
  if (!topic) notFound();

  const claims = await getTopicClaims(slug);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <header className="mb-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">Topic</div>
        <h1 className="font-display text-4xl italic text-ink-100">{topic.name}</h1>
        {topic.description && <p className="mt-2 max-w-2xl text-sm text-ink-400">{topic.description}</p>}
      </header>

      {claims.length === 0 ? (
        <EmptyState title="No claims yet" body="No claims have been tagged with this topic yet." />
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
