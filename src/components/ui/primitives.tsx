export function SectionHeading({
  eyebrow,
  title,
  href,
  hrefLabel,
}: {
  eyebrow: string;
  title: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="mb-6 flex items-end justify-between border-b border-hairline pb-3">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent-brass">
          {eyebrow}
        </div>
        <h2 className="font-display text-2xl italic text-ink-100">{title}</h2>
      </div>
      {href && (
        <a
          href={href}
          className="font-mono text-xs uppercase tracking-wide text-ink-400 hover:text-accent-brass"
        >
          {hrefLabel ?? "View all →"}
        </a>
      )}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-dashed border-hairline px-6 py-10 text-center">
      <p className="font-display text-lg italic text-ink-300">{title}</p>
      <p className="mt-2 text-sm text-ink-600">{body}</p>
    </div>
  );
}

export function InformationTypeTag({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center border border-hairline px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-400">
      {type}
    </span>
  );
}
