import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, UnauthenticatedError, UnauthorizedError } from "@/lib/auth/requireAdmin";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/admin/login");
    throw err;
  }

  return (
    <div className="min-h-screen bg-bg-void text-ink-100">
      <div className="flex min-h-screen">
        <aside className="w-56 shrink-0 border-r border-hairline bg-bg-panel p-4">
          <div className="mb-6">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-brass">Admin</div>
            <div className="font-display text-lg italic">The Ledger</div>
          </div>
          <nav className="flex flex-col gap-1 text-sm">
            <AdminNavLink href="/admin">Dashboard</AdminNavLink>
            <AdminNavLink href="/admin/claims">Claims</AdminNavLink>
            <AdminNavLink href="/admin/sources">Sources</AdminNavLink>
            <AdminNavLink href="/admin/source-items">Source Items</AdminNavLink>
            <AdminNavLink href="/admin/evidence">Evidence</AdminNavLink>
            <AdminNavLink href="/admin/topics">Topics</AdminNavLink>
            <AdminNavLink href="/admin/ingest">Ingest</AdminNavLink>
            <AdminNavLink href="/admin/ingest/history">Ingestion History</AdminNavLink>
            <AdminNavLink href="/admin/discovery-feeds">Discovery Feeds</AdminNavLink>
            <AdminNavLink href="/admin/review">AI/Admin Review</AdminNavLink>
            <AdminNavLink href="/admin/review/history">AI Review History</AdminNavLink>
          </nav>
          <div className="mt-8 border-t border-hairline pt-4 font-mono text-[11px] text-ink-600">
            <div>{admin.displayName}</div>
            <div>{admin.email}</div>
            <div className="mt-1 uppercase tracking-wide text-accent-brass">{admin.role}</div>
          </div>
          <Link href="/" className="mt-4 block font-mono text-[10px] uppercase tracking-wide text-ink-600 hover:text-accent-brass">
            ← Back to public site
          </Link>
        </aside>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function AdminNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="rounded-none px-2 py-1.5 text-ink-300 hover:bg-bg-panel-raised hover:text-accent-brass">
      {children}
    </Link>
  );
}
