import type { Metadata } from "next";
import Link from "next/link";
import { getTopics } from "@/db/queries/topics";
import { EmptyState } from "@/components/ui/primitives";

// Render fresh on every request -- see (public)/layout.tsx for why.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Topics",
  description: "Browse GTA VI claims by topic.",
};

export default async function TopicsPage() {
  const topics = await getTopics();

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <header className="mb-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">Index</div>
        <h1 className="font-display text-4xl italic text-ink-100">Topics</h1>
      </header>

      {topics.length === 0 ? (
        <EmptyState title="No topics yet" body="Topics will appear here as claims are categorized." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {topics.map((t) => (
            <li key={t.id}>
              <Link
                href={`/topics/${t.slug}`}
                className="flex items-center justify-between border border-hairline bg-bg-panel px-4 py-3 hover:border-accent-brass/60"
              >
                <span className="font-display text-lg text-ink-100">{t.name}</span>
                <span className="font-mono text-xs text-ink-600">{t.claimCount}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
