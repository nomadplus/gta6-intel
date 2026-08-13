import Link from "next/link";
import { listSourcesForAdmin } from "@/db/queries/admin";

export default async function AdminSourcesListPage() {
  const sources = await listSourcesForAdmin();
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Sources</h1>
        <Link href="/admin/sources/new" className="border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void">
          + New Source
        </Link>
      </div>
      <ul className="divide-y divide-hairline border border-hairline text-sm">
        {sources.map((s) => (
          <li key={s.id} className="flex items-center justify-between p-3">
            <Link href={`/admin/sources/${s.id}`} className="text-ink-100 hover:text-accent-brass">
              {s.name}
            </Link>
            <span className="font-mono text-xs text-ink-600">{s.sourceTypeLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
