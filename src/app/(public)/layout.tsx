import Link from "next/link";

/**
 * Renders every page on every request instead of once at build time.
 *
 * Found during staging verification: without this, Next.js statically
 * generates these pages using whatever was in the database at deploy
 * time, and never re-checks it -- so an admin-created claim, topic, or
 * status change wouldn't appear on the public site until the next
 * redeploy. This never surfaced in local testing because `next dev`
 * doesn't do the same build-time prerendering that production does, and
 * every earlier production test happened to run right after a fresh
 * seed with no later admin writes to miss.
 *
 * Public reads are already cheap, cached-nowhere-else database queries
 * (no AI calls, no external requests), so rendering per-request is the
 * correct trade here, not a performance concern -- and it's what
 * "the public site reflects admin changes" actually requires.
 */
export const dynamic = "force-dynamic";

/**
 * Nested layout, scoped only to the (public) route group by folder
 * placement -- NOT a root layout (no <html>/<body> here; those live in
 * the real root layout at src/app/layout.tsx). Admin pages are a sibling
 * of this group and never pass through this file.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="border-b border-hairline bg-bg-panel/60 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-display text-xl italic tracking-tight text-ink-100">
            The Ledger
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:inline">
            GTA VI Claim Archive
          </span>
        </Link>
        <nav aria-label="Primary" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <NavLink href="/claims">Claims</NavLink>
          <NavLink href="/timeline">Timeline</NavLink>
          <NavLink href="/topics">Topics</NavLink>
          <NavLink href="/confirmed">Confirmed</NavLink>
          <NavLink href="/graveyard">Graveyard</NavLink>
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-ink-300 transition-colors hover:text-accent-brass focus-visible:text-accent-brass"
    >
      {children}
    </Link>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto max-w-6xl px-4 py-8 text-xs text-ink-600 sm:px-6">
        <p className="max-w-2xl">
          The Ledger tracks claims, not articles. Every statement here is traced to its original
          reporting and shown alongside how it changed over time. This is an independent research
          project and is not affiliated with, endorsed by, or sponsored by Rockstar Games or
          Take-Two Interactive.
        </p>
      </div>
    </footer>
  );
}
